require('dotenv').config();

const express = require('express');
const https = require('https');
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
  ELEVENLABS_VOICE_ID = 'XrExE9yKIg1WjnnlVkGX', // "Matilda" — warm Australian-ish female
  PORT = 10000,
} = process.env;

const BASE_URL = 'https://christiansai-voice.onrender.com';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

log(`SID: ${TWILIO_ACCOUNT_SID ? TWILIO_ACCOUNT_SID.substring(0, 10) + '...' : 'MISSING'}`);
log(`ElevenLabs: ${ELEVENLABS_API_KEY ? 'configured' : 'not set — using Polly'}`);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Cache ElevenLabs audio in memory
let greetingAudioBuffer = null;
let thankYouAudioBuffer = null;

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
        'Accept': 'audio/mpeg',
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

async function warmElevenLabsCache() {
  if (!ELEVENLABS_API_KEY) return;
  try {
    log('Generating ElevenLabs greeting audio...');
    greetingAudioBuffer = await generateElevenLabsAudio(
      "Hi, you've reached Christian's AI for Business. I'm Sarah, Christian's AI assistant. " +
      "Christian is out meeting clients right now, but I'm here to help. " +
      "Can I grab your name and a quick note on what you're looking for? Just speak after the tone."
    );
    log(`Greeting audio cached: ${greetingAudioBuffer.length} bytes`);

    thankYouAudioBuffer = await generateElevenLabsAudio(
      "Perfect, thanks for that. Christian will give you a call back within 24 hours. " +
      "We'll also send you a quick text to confirm. Have a great day!"
    );
    log(`Thank-you audio cached: ${thankYouAudioBuffer.length} bytes`);
  } catch (err) {
    log(`ElevenLabs cache warm failed: ${err.message} — falling back to Polly`);
  }
}

// Serve cached audio
app.get('/audio/greeting.mp3', (req, res) => {
  if (!greetingAudioBuffer) return res.status(404).send('Not ready');
  res.set('Content-Type', 'audio/mpeg');
  res.send(greetingAudioBuffer);
});

app.get('/audio/thankyou.mp3', (req, res) => {
  if (!thankYouAudioBuffer) return res.status(404).send('Not ready');
  res.set('Content-Type', 'audio/mpeg');
  res.send(thankYouAudioBuffer);
});

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

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'christiansai-voice',
    elevenlabs: !!ELEVENLABS_API_KEY,
    greetingCached: !!greetingAudioBuffer,
    thankYouCached: !!thankYouAudioBuffer,
  });
});

// POST /voice
app.post('/voice', (req, res) => {
  try {
    const caller = req.body.From || 'unknown';
    log(`Inbound call from ${caller}`);

    const twiml = new VoiceResponse();
    const useElevenLabs = ELEVENLABS_API_KEY && greetingAudioBuffer && thankYouAudioBuffer;

    if (useElevenLabs) {
      twiml.play(`${BASE_URL}/audio/greeting.mp3`);
    } else {
      twiml.say(
        { voice: 'Polly.Joanna' },
        "Hi, you've reached Christian's AI for Business. I'm Sarah, Christian's AI assistant. " +
        "Christian is out meeting clients right now, but I'm here to help. " +
        "Can I grab your name and a quick note on what you're looking for? Just speak after the tone."
      );
    }

    twiml.record({
      maxLength: 60,
      transcribe: true,
      transcribeCallback: `${BASE_URL}/transcription`,
      playBeep: true,
    });

    if (useElevenLabs) {
      twiml.play(`${BASE_URL}/audio/thankyou.mp3`);
    } else {
      twiml.say(
        { voice: 'Polly.Joanna' },
        "Perfect, thanks for that. Christian will give you a call back within 24 hours. " +
        "We'll also send you a quick text to confirm. Have a great day!"
      );
    }

    // Notify Christian immediately
    sendSms(CHRISTIAN_MOBILE, `📞 New lead from ${caller} — recording on its way. Call them back ASAP.`);

    // Caller confirmation — stagger by 3s to avoid carrier spam block
    if (caller !== 'unknown' && caller !== CHRISTIAN_MOBILE) {
      sendSms(caller, `Hi! Thanks for calling Christian's AI for Business. Christian will call you back within 24 hours. — Sarah`, 3000);
    }

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice: ${err.message}`);
    const fallback = new VoiceResponse();
    fallback.say("Thanks for calling Christian's AI for Business. Please leave a message after the tone.");
    fallback.record({ maxLength: 60, transcribe: true, transcribeCallback: `${BASE_URL}/transcription`, playBeep: true });
    res.type('text/xml');
    res.send(fallback.toString());
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
    twiml.message("Hi! Thanks for texting Christian's AI for Business. Christian will get back to you shortly. — Sarah");
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /sms: ${err.message}`);
    res.sendStatus(200);
  }
});

app.listen(PORT, async () => {
  log(`christiansai-voice listening on port ${PORT}`);
  await warmElevenLabsCache();
});
