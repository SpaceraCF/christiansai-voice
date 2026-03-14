require('dotenv').config();

const express = require('express');
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
  PORT = 10000,
} = process.env;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

log(`Starting with SID: ${TWILIO_ACCOUNT_SID ? TWILIO_ACCOUNT_SID.substring(0,10)+'...' : 'MISSING'}`);
log(`Christian mobile: ${CHRISTIAN_MOBILE || 'MISSING'}`);
log(`Twilio number: ${TWILIO_PHONE_NUMBER || 'MISSING'}`);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

function sendSms(to, body) {
  if (!to || to === 'unknown') {
    log(`Skipping SMS — no valid recipient`);
    return Promise.resolve();
  }
  return client.messages
    .create({ to, from: TWILIO_PHONE_NUMBER, body })
    .then((m) => log(`SMS sent to ${to} (sid: ${m.sid})`))
    .catch((err) => log(`SMS send failed to ${to}: ${err.message}`));
}

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'christiansai-voice',
    config: {
      hasSid: !!TWILIO_ACCOUNT_SID,
      hasAuth: !!TWILIO_AUTH_TOKEN,
      hasPhone: !!TWILIO_PHONE_NUMBER,
      hasChristian: !!CHRISTIAN_MOBILE,
    }
  });
});

// POST /voice — inbound call handler
app.post('/voice', (req, res) => {
  try {
    const caller = req.body.From || 'unknown';
    log(`Inbound call from ${caller}`);

    const twiml = new VoiceResponse();

    twiml.say(
      { voice: 'Polly.Joanna' },
      "Hi, you've reached Christian's AI for Business. I'm Sarah, Christian's AI assistant. " +
      "Christian is out meeting clients right now, but I'm here to help. " +
      "Can I grab your name and a quick note on what you're looking for? Just speak after the tone."
    );

    twiml.record({
      maxLength: 60,
      transcribeCallback: `https://christiansai-voice.onrender.com/transcription`,
      playBeep: true,
    });

    twiml.say(
      { voice: 'Polly.Joanna' },
      "Perfect, thanks for that. Christian will give you a call back within 24 hours. " +
      "We'll also send you a quick text to confirm. Have a great day!"
    );

    // Notify Christian (async, don't block response)
    sendSms(CHRISTIAN_MOBILE, `📞 New lead from ${caller} — recording coming shortly. Call them back ASAP.`);

    // Confirm to caller (async)
    if (caller !== 'unknown') {
      sendSms(caller, `Hi! Thanks for calling Christian's AI for Business. Christian will call you back within 24 hours. — Sarah 😊 | christiansai.com.au`);
    }

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /voice: ${err.message}\n${err.stack}`);
    // Still return valid TwiML so Twilio doesn't say "application error"
    const fallback = new VoiceResponse();
    fallback.say("Thanks for calling Christian's AI for Business. Please leave a message after the tone, or call back shortly.");
    fallback.record({ maxLength: 60, playBeep: true });
    res.type('text/xml');
    res.send(fallback.toString());
  }
});

// POST /transcription
app.post('/transcription', (req, res) => {
  try {
    const caller = req.body.From || 'unknown';
    const transcription = req.body.TranscriptionText || '(no transcription available)';
    log(`Transcription from ${caller}: ${transcription}`);
    sendSms(CHRISTIAN_MOBILE, `📞 Lead transcription from ${caller}: ${transcription}`);
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
      "Hi! Thanks for texting Christian's AI for Business. Christian will get back to you shortly. " +
      "For faster help, visit christiansai.com.au — Sarah 😊"
    );

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    log(`ERROR in /sms: ${err.message}`);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  log(`christiansai-voice listening on port ${PORT}`);
});
