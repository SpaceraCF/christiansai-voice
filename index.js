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
  VALIDATE_TWILIO_SIG,
  PORT = 3000,
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sendSms(to, body) {
  return client.messages
    .create({ to, from: TWILIO_PHONE_NUMBER, body })
    .then((m) => log(`SMS sent to ${to} (sid: ${m.sid})`))
    .catch((err) => log(`SMS send failed to ${to}: ${err.message}`));
}

// Optional Twilio signature validation middleware
function validateTwilioSignature(req, res, next) {
  if (VALIDATE_TWILIO_SIG !== 'true') return next();

  const signature = req.headers['x-twilio-signature'] || '';
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);

  if (!valid) {
    log('Invalid Twilio signature — rejecting request');
    return res.status(403).send('Forbidden');
  }
  next();
}

app.use(validateTwilioSignature);

// POST /voice — inbound call handler
app.post('/voice', (req, res) => {
  const caller = req.body.From || 'unknown';
  log(`Inbound call from ${caller}`);

  const twiml = new VoiceResponse();

  twiml.say(
    { voice: 'Polly.Joanna' },
    "Hi, you've reached Christian's AI for Business. I'm Sarah, Christian's AI assistant. " +
      'Christian is out meeting clients right now, but I\'m here to help. ' +
      "Can I grab your name and a quick note on what you're looking for? Just speak after the tone."
  );

  twiml.record({
    maxLength: 60,
    transcribeCallback: '/transcription',
    playBeep: true,
  });

  twiml.say(
    { voice: 'Polly.Joanna' },
    "Perfect, thanks for that. Christian will give you a call back within 24 hours. " +
      "We'll also send you a quick text to confirm. Have a great day!"
  );

  // Notify Christian
  sendSms(
    CHRISTIAN_MOBILE,
    `\ud83d\udcde New lead from ${caller} \u2014 recording available in Twilio console. Call them back ASAP.`
  );

  // Confirm to caller
  sendSms(
    caller,
    "Hi! Thanks for calling Christian's AI for Business. Christian will call you back within 24 hours. \u2014 Sarah \ud83d\ude0a | christiansai.com.au"
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// POST /transcription — Twilio posts transcription when ready
app.post('/transcription', (req, res) => {
  const caller = req.body.From || 'unknown';
  const transcription = req.body.TranscriptionText || '(no transcription available)';
  log(`Transcription from ${caller}: ${transcription}`);

  sendSms(
    CHRISTIAN_MOBILE,
    `\ud83d\udcde Lead transcription from ${caller}: ${transcription}`
  );

  res.sendStatus(200);
});

// POST /sms — inbound SMS handler
app.post('/sms', (req, res) => {
  const sender = req.body.From || 'unknown';
  const body = req.body.Body || '';
  log(`Inbound SMS from ${sender}: ${body}`);

  // Forward to Christian
  sendSms(CHRISTIAN_MOBILE, `\ud83d\udcac SMS from ${sender}: ${body}`);

  // Auto-reply
  const twiml = new MessagingResponse();
  twiml.message(
    "Hi! Thanks for texting Christian's AI for Business. Christian will get back to you shortly. " +
      'For faster help, visit christiansai.com.au \u2014 Sarah \ud83d\ude0a'
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'christiansai-voice' });
});

app.listen(PORT, () => {
  log(`christiansai-voice listening on port ${PORT}`);
});
