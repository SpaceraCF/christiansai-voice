require('dotenv').config();

const express = require('express');
const https = require('https');
const crypto = require('crypto');
const twilio = require('twilio');
const { VoiceResponse, MessagingResponse } = twilio.twiml;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  CHRISTIAN_MOBILE,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID = 'XrExE9yKIg1WjnnlVkGX',
  CAL_API_KEY,
  CAL_EVENT_TYPE_ID = '4308229',
  CAL_USERNAME = 'cfspacera',
  PORT = 10000,
  BASE_URL = 'https://christiansai-voice.onrender.com',
} = process.env;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

log(`SID: ${TWILIO_ACCOUNT_SID ? TWILIO_ACCOUNT_SID.substring(0, 10) + '...' : 'MISSING'}`);
log(`ElevenLabs: ${ELEVENLABS_API_KEY ? 'configured' : 'not set — using Polly'}`);
log(`Cal.com: ${CAL_API_KEY ? 'configured' : 'NOT SET'}`);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------
const sessions = {};

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const sid of Object.keys(sessions)) {
    if (sessions[sid].createdAt < cutoff) {
      delete sessions[sid];
    }
  }
}, 60 * 1000);

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------
const audioCache = {}; // key → Buffer

function generateElevenLabsAudio(text) {
  return new Promise((resolve, reject) => {
    if (!ELEVENLABS_API_KEY) return reject(new Error('No ElevenLabs key'));

    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(Buffer.concat(chunks));
        } else {
          const err = Buffer.concat(chunks).toString();
          reject(new Error(`ElevenLabs ${res.statusCode}: ${err.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Static prompts to pre-generate
const STATIC_PROMPTS = {
  greeting:
    "Hi, you've reached Christian's AI for Business. I'm Sarah. Christian's out meeting clients, but I can help. Would you like me to book you in for a chat with Christian, or would you prefer to leave a message? Press 1 to book a meeting, or press 2 to leave a message.",
  'leave-message':
    'No worries! Leave your message after the tone and Christian will get back to you soon.',
  'ask-name': "What's your first name?",
  'booking-failed':
    "Sorry, I wasn't able to complete the booking. I'll let Christian know you called and he'll be in touch soon.",
  'no-slots':
    "Christian's calendar is pretty full at the moment. I'll let him know you called and he'll reach out to book a time. Have a great day!",
  'ask-location':
    "Would you like to meet virtually over a video call, or catch up in person? Press 1 for a video call, or press 2 for in person.",
};

async function warmElevenLabsCache() {
  if (!ELEVENLABS_API_KEY) {
    log('No ElevenLabs key — will use Polly fallback');
    return;
  }
  for (const [name, text] of Object.entries(STATIC_PROMPTS)) {
    try {
      log(`Generating ElevenLabs audio: ${name}...`);
      audioCache[name] = await generateElevenLabsAudio(text);
      log(`  cached ${name}.mp3 (${audioCache[name].length} bytes)`);
    } catch (err) {
      log(`  FAILED ${name}: ${err.message}`);
    }
  }
}

// Get or generate a dynamic audio clip, cached by content hash
async function getDynamicAudio(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');
  if (audioCache[hash]) return hash;
  try {
    audioCache[hash] = await generateElevenLabsAudio(text);
    log(`Dynamic audio cached: ${hash} (${audioCache[hash].length} bytes)`);
    return hash;
  } catch (err) {
    log(`Dynamic audio failed: ${err.message}`);
    return null;
  }
}

// Serve cached audio
app.get('/audio/:key.mp3', (req, res) => {
  const buf = audioCache[req.params.key];
  if (!buf) return res.status(404).send('Not found');
  res.set('Content-Type', 'audio/mpeg');
  res.send(buf);
});

// Helper: add Play or Say to TwiML
function playOrSay(twiml, cacheKey, fallbackText) {
  if (audioCache[cacheKey]) {
    twiml.play(`${BASE_URL}/audio/${cacheKey}.mp3`);
  } else {
    twiml.say({ voice: 'Polly.Joanna' }, fallbackText);
  }
}

// ---------------------------------------------------------------------------
// Cal.com helpers
// ---------------------------------------------------------------------------
function calRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.cal.com/v2${path}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${CAL_API_KEY}`,
        'cal-api-version': '2024-06-14',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          reject(new Error(`Cal.com parse error: ${raw.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAvailableSlots() {
  const now = new Date();
  const startTime = now.toISOString();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const endTime = end.toISOString();

  const path = `/slots/available?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&eventTypeId=${CAL_EVENT_TYPE_ID}&timeZone=Australia/Sydney`;
  const resp = await calRequest('GET', path);

  if (resp.status !== 200) {
    log(`Cal.com slots error ${resp.status}: ${JSON.stringify(resp.data).substring(0, 200)}`);
    return [];
  }

  const slotsObj = resp.data?.data?.slots || {};
  const allSlots = [];

  for (const daySlots of Object.values(slotsObj)) {
    for (const slot of daySlots) {
      const t = new Date(slot.time);
      // Filter 9am-5pm AEST
      const sydneyHour = parseInt(
        new Intl.DateTimeFormat('en-AU', {
          timeZone: 'Australia/Sydney',
          hour: 'numeric',
          hour12: false,
        }).format(t),
        10
      );
      if (sydneyHour >= 9 && sydneyHour < 17) {
        allSlots.push(slot.time);
      }
    }
  }

  // Sort and return up to 5
  allSlots.sort((a, b) => new Date(a) - new Date(b));
  return allSlots.slice(0, 5);
}

async function createBooking(slotTime, name, callerNumber, loc = 'virtual') {
  const location = loc === 'inperson'
    ? 'attendeeAddress'
    : 'integrations:office365video';

  const body = {
    eventTypeId: parseInt(CAL_EVENT_TYPE_ID, 10),
    start: slotTime,
    attendee: {
      name,
      email: `phone_${callerNumber.replace(/\+/g, '')}@christiansai.com.au`,
      timeZone: 'Australia/Sydney',
      phoneNumber: callerNumber,
    },
    location,
    metadata: { source: 'phone', callerNumber, meetingType: loc },
  };

  const resp = await calRequest('POST', '/bookings', body);
  log(`Cal.com booking response ${resp.status}: ${JSON.stringify(resp.data).substring(0, 300)}`);
  return resp;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatSlotForSpeech(isoTime) {
  const d = new Date(isoTime);
  const weekday = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long',
  }).format(d);
  const day = parseInt(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      day: 'numeric',
    }).format(d),
    10
  );
  const month = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    month: 'long',
  }).format(d);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: 'numeric',
      hour12: false,
    }).format(d),
    10
  );

  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const ampm = hour < 12 ? 'am' : 'pm';
  const h12 = hour % 12 || 12;

  return `${weekday} the ${ordinal(day)} of ${month} at ${h12} ${ampm}`;
}

function formatSlotShort(isoTime) {
  const d = new Date(isoTime);
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

// ---------------------------------------------------------------------------
// SMS helper
// ---------------------------------------------------------------------------
function sendSms(to, body, delayMs = 0) {
  if (!to || to === 'unknown') return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(() => {
      client.messages
        .create({ to, from: TWILIO_PHONE_NUMBER, body })
        .then((m) => { log(`SMS sent to ${to} (${m.sid})`); resolve(); })
        .catch((err) => { log(`SMS failed to ${to}: ${err.message}`); resolve(); });
    }, delayMs);
  });
}

// ---------------------------------------------------------------------------
// Error TwiML helper
// ---------------------------------------------------------------------------
function errorTwiml() {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'Polly.Joanna' },
    "I'm sorry, something went wrong on our end. Please try calling back or send us a text. Goodbye."
  );
  twiml.hangup();
  return twiml;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'christiansai-voice',
    elevenlabs: !!ELEVENLABS_API_KEY,
    cachedAudio: Object.keys(audioCache).filter((k) => !k.match(/^[a-f0-9]{32}$/)),
    calConfigured: !!CAL_API_KEY,
  });
});

// POST /voice — entry point
app.post('/voice', (req, res) => {
  try {
    const caller = req.body.From || 'unknown';
    log(`Inbound call from ${caller}`);

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: 'dtmf',
      numDigits: 1,
      timeout: 5,
      action: `${BASE_URL}/voice/intent`,
      method: 'POST',
    });

    if (audioCache['greeting']) {
      gather.play(`${BASE_URL}/audio/greeting.mp3`);
    } else {
      gather.say({ voice: 'Polly.Joanna' }, STATIC_PROMPTS.greeting);
    }

    // If no input, redirect to intent with no digits (will go to record)
    twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/intent`);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice: ${err.message}`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /voice/intent
app.post('/voice/intent', async (req, res) => {
  try {
    const digits = req.body.Digits || '';
    const callSid = req.body.CallSid || '';
    const caller = req.body.From || 'unknown';
    log(`Intent: Digits=${digits} CallSid=${callSid}`);

    if (digits === '1') {
      // Book a meeting — fetch slots
      const slots = await getAvailableSlots();
      log(`Found ${slots.length} available slots`);

      if (slots.length === 0) {
        const twiml = new VoiceResponse();
        playOrSay(twiml, 'no-slots', STATIC_PROMPTS['no-slots']);
        twiml.hangup();

        sendSms(CHRISTIAN_MOBILE, `📞 ${caller} wanted to book but no slots available — call them back`);
        if (caller !== 'unknown' && caller !== CHRISTIAN_MOBILE) {
          sendSms(caller, "Hi! Thanks for calling Christian's AI for Business. Christian's calendar is full right now but he'll reach out to book a time. — Sarah", 3000);
        }

        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // Store session
      sessions[callSid] = { slots, slotIndex: 0, callerName: '', createdAt: Date.now() };

      // Present first slot
      const slotText = formatSlotForSpeech(slots[0]);
      const promptText = `I have ${slotText} available. Press 1 to book that slot, or press 2 to hear the next option.`;

      const twiml = new VoiceResponse();
      const gather = twiml.gather({
        input: 'dtmf',
        numDigits: 1,
        timeout: 5,
        action: `${BASE_URL}/voice/pick-slot?slotIndex=0`,
        method: 'POST',
      });

      const audioKey = await getDynamicAudio(promptText);
      if (audioKey) {
        gather.play(`${BASE_URL}/audio/${audioKey}.mp3`);
      } else {
        gather.say({ voice: 'Polly.Joanna' }, promptText);
      }

      twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/pick-slot?slotIndex=0`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Digits "2" or timeout — leave a message
    const twiml = new VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/record`);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice/intent: ${err.message}`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /voice/pick-slot
app.post('/voice/pick-slot', async (req, res) => {
  try {
    const digits = req.body.Digits || '';
    const callSid = req.body.CallSid || '';
    const slotIndex = parseInt(req.query.slotIndex || '0', 10);
    const session = sessions[callSid];

    if (!session) {
      log(`No session for ${callSid}`);
      res.type('text/xml');
      return res.send(errorTwiml().toString());
    }

    if (digits === '1') {
      // Confirm this slot → ask location (virtual or in-person)
      const slot = session.slots[slotIndex];
      const twiml = new VoiceResponse();
      twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/location?slot=${encodeURIComponent(slot)}`);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Digit "2" or timeout — next slot
    const nextIndex = slotIndex + 1;
    if (nextIndex >= session.slots.length) {
      // No more slots
      const twiml = new VoiceResponse();
      playOrSay(twiml, 'no-slots', STATIC_PROMPTS['no-slots']);
      twiml.hangup();

      const caller = req.body.From || 'unknown';
      sendSms(CHRISTIAN_MOBILE, `📞 ${caller} went through all slots but didn't book — call them back`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Present next slot
    const nextSlot = session.slots[nextIndex];
    const slotText = formatSlotForSpeech(nextSlot);
    const isLast = nextIndex === session.slots.length - 1;
    const promptText = isLast
      ? `I have ${slotText} available. This is the last available slot. Press 1 to book it, or press 2 to skip.`
      : `I have ${slotText} available. Press 1 to book that slot, or press 2 to hear the next option.`;

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: 'dtmf',
      numDigits: 1,
      timeout: 5,
      action: `${BASE_URL}/voice/pick-slot?slotIndex=${nextIndex}`,
      method: 'POST',
    });

    const audioKey = await getDynamicAudio(promptText);
    if (audioKey) {
      gather.play(`${BASE_URL}/audio/${audioKey}.mp3`);
    } else {
      gather.say({ voice: 'Polly.Joanna' }, promptText);
    }

    twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/pick-slot?slotIndex=${nextIndex}`);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice/pick-slot: ${err.message}`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /voice/location — ask virtual or in-person
app.post('/voice/location', async (req, res) => {
  try {
    const slot = req.query.slot;
    const twiml = new VoiceResponse();
    const promptText = "Would you like to meet virtually over a video call, or catch up in person? Press 1 for a video call, or press 2 for in person.";
    const gather = twiml.gather({
      input: 'dtmf',
      numDigits: 1,
      timeout: 8,
      action: `${BASE_URL}/voice/get-name?slot=${encodeURIComponent(slot)}`,
      method: 'POST',
    });

    if (audioCache['ask-location']) {
      gather.play(`${BASE_URL}/audio/ask-location.mp3`);
    } else {
      gather.say({ voice: 'Polly.Joanna' }, promptText);
    }

    // Default to virtual if no response
    twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/get-name?slot=${encodeURIComponent(slot)}&loc=virtual`);
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice/location: ${err.message}`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /voice/get-name
app.post('/voice/get-name', (req, res) => {
  try {
    const slot = req.query.slot;
    // loc: "1"=virtual, "2"=inperson (from gather digits), or "virtual" (default redirect)
    const locDigit = req.body.Digits || req.query.loc || '1';
    const loc = locDigit === '2' ? 'inperson' : 'virtual';

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: 'speech',
      timeout: 5,
      speechTimeout: 2,
      action: `${BASE_URL}/voice/book?slot=${encodeURIComponent(slot)}&loc=${loc}`,
      method: 'POST',
    });

    if (audioCache['ask-name']) {
      gather.play(`${BASE_URL}/audio/ask-name.mp3`);
    } else {
      gather.say({ voice: 'Polly.Joanna' }, STATIC_PROMPTS['ask-name']);
    }

    twiml.redirect({ method: 'POST' }, `${BASE_URL}/voice/book?slot=${encodeURIComponent(slot)}&loc=${loc}`);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice/get-name: ${err.message}`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /voice/book
app.post('/voice/book', async (req, res) => {
  try {
    const slot = req.query.slot;
    const loc = req.query.loc || 'virtual'; // 'virtual' or 'inperson'
    const speechResult = req.body.SpeechResult || '';
    const caller = req.body.From || 'unknown';
    const callSid = req.body.CallSid || '';

    // Extract and format name
    let name = speechResult.trim();
    if (name) {
      name = name.replace(/[^a-zA-Z\s'-]/g, '').trim();
      name = name.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    if (!name) name = 'Valued Customer';

    log(`Booking: name="${name}" slot=${slot} loc=${loc} caller=${caller}`);

    // Create booking via Cal.com
    const result = await createBooking(slot, name, caller, loc);
    const slotSpeech = formatSlotForSpeech(slot);
    const slotShort = formatSlotShort(slot);

    if (result.status >= 200 && result.status < 300) {
      // Success
      const confirmText = `Perfect! I've booked you in with Christian for ${slotSpeech} Sydney time. You'll get a text confirmation shortly. Have a great day!`;

      const twiml = new VoiceResponse();
      const audioKey = await getDynamicAudio(confirmText);
      if (audioKey) {
        twiml.play(`${BASE_URL}/audio/${audioKey}.mp3`);
      } else {
        twiml.say({ voice: 'Polly.Joanna' }, confirmText);
      }
      twiml.hangup();

      // Extract Teams link from booking response if available
      const meetingUrl = result.data?.data?.meetingUrl || result.data?.meetingUrl || null;
      const locLabel = loc === 'inperson' ? 'in person (Central West NSW)' : 'via video call';

      sendSms(CHRISTIAN_MOBILE,
        `📅 New booking! ${name} (${caller}) booked for ${slotShort} — ${locLabel}` +
        (meetingUrl ? ` | Teams: ${meetingUrl}` : '')
      );
      if (caller !== 'unknown' && caller !== CHRISTIAN_MOBILE) {
        const callerMsg = loc === 'inperson'
          ? `Hi ${name}! You're booked with Christian for ${slotShort} (Sydney time) in person. He'll confirm the exact location. — Sarah`
          : `Hi ${name}! You're booked with Christian for ${slotShort} (Sydney time) via video call.${meetingUrl ? ` Join here: ${meetingUrl}` : ' Christian will send the link shortly.'} — Sarah`;
        sendSms(caller, callerMsg, 3000);
      }

      // Clean up session
      delete sessions[callSid];

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Booking failed
    log(`Booking failed: ${JSON.stringify(result.data).substring(0, 300)}`);
    const twiml = new VoiceResponse();
    playOrSay(twiml, 'booking-failed', STATIC_PROMPTS['booking-failed']);
    twiml.hangup();

    sendSms(CHRISTIAN_MOBILE, `📞 ${caller} tried to book but it failed — call them back`);
    delete sessions[callSid];

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice/book: ${err.message}`);
    const caller = req.body.From || 'unknown';
    sendSms(CHRISTIAN_MOBILE, `📞 ${caller} tried to book but it failed — call them back`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /voice/record
app.post('/voice/record', (req, res) => {
  try {
    const caller = req.body.From || 'unknown';

    const twiml = new VoiceResponse();
    playOrSay(twiml, 'leave-message', STATIC_PROMPTS['leave-message']);
    twiml.record({
      maxLength: 60,
      transcribe: true,
      transcribeCallback: `${BASE_URL}/transcription`,
      playBeep: true,
    });
    twiml.say({ voice: 'Polly.Joanna' }, "Thanks! Christian will be in touch soon. Bye!");

    sendSms(CHRISTIAN_MOBILE, `📞 New message from ${caller} — check Twilio for recording`);
    if (caller !== 'unknown' && caller !== CHRISTIAN_MOBILE) {
      sendSms(caller, "Hi! Thanks for calling. Christian will be in touch soon. — Sarah", 3000);
    }

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice/record: ${err.message}`);
    res.type('text/xml');
    res.send(errorTwiml().toString());
  }
});

// POST /transcription
app.post('/transcription', (req, res) => {
  try {
    const caller = req.body.From || req.body.Called || 'unknown';
    const transcription = req.body.TranscriptionText || '(no transcription yet)';
    log(`Transcription from ${caller}: ${transcription}`);
    sendSms(CHRISTIAN_MOBILE, `📝 Message from ${caller}: "${transcription}"`);
  } catch (err) {
    log(`ERROR in /transcription: ${err.message}`);
  }
  res.sendStatus(200);
});

// POST /sms
app.post('/sms', (req, res) => {
  try {
    const sender = req.body.From || 'unknown';
    const body = req.body.Body || '';
    log(`Inbound SMS from ${sender}: ${body}`);

    sendSms(CHRISTIAN_MOBILE, `💬 SMS from ${sender}: ${body}`);

    const twiml = new MessagingResponse();
    twiml.message(
      "Hi! Thanks for texting Christian's AI for Business. Christian will get back to you shortly. — Sarah"
    );
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /sms: ${err.message}`);
    res.sendStatus(200);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  log(`christiansai-voice listening on port ${PORT}`);
  await warmElevenLabsCache();
  log('Ready to receive calls');
});
