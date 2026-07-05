// Minimal SMTP submission client over implicit TLS (port 465). Zero npm
// dependencies: a node:tls socket speaking just enough ESMTP (EHLO,
// AUTH LOGIN, one message per connection) for transactional auth mail.
// Deliverability comes from the relay host (SPF, DKIM, DMARC live there).
import { randomBytes } from 'node:crypto';
import { connect } from 'node:tls';

const CRLF = '\r\n';
const TIMEOUT_MS = 20_000;

/** Fold LF text into CRLF and dot-stuff lines so a leading "." never
 *  terminates the DATA phase early. */
function toWireBody(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

/**
 * Send one plain-text message. Resolves on 250 after DATA, rejects on any
 * unexpected reply, TLS failure or timeout. No retries here: callers decide
 * whether a send is worth retrying (auth mail is; a resend button exists).
 *
 * @param {{host: string, port: number, user: string, pass: string,
 *          from: string, fromName: string}} cfg
 * @param {{to: string, subject: string, text: string}} msg
 */
export function sendMail(cfg, msg) {
  const domain = cfg.from.split('@')[1] ?? cfg.host;
  const headers = [
    `From: ${cfg.fromName} <${cfg.from}>`,
    `To: <${msg.to}>`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(9).toString('hex')}.${Date.now()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ].join(CRLF);
  const payload = `${headers}${CRLF}${CRLF}${toWireBody(msg.text)}${CRLF}.`;

  // The whole session is a fixed script: wait for the expected reply code,
  // send the next line. Any deviation aborts the connection.
  const script = [
    { expect: 220, send: `EHLO ${domain}` },
    { expect: 250, send: 'AUTH LOGIN' },
    { expect: 334, send: Buffer.from(cfg.user).toString('base64') },
    { expect: 334, send: Buffer.from(cfg.pass).toString('base64') },
    { expect: 235, send: `MAIL FROM:<${cfg.from}>` },
    { expect: 250, send: `RCPT TO:<${msg.to}>` },
    { expect: 250, send: 'DATA' },
    { expect: 354, send: payload },
    { expect: 250, send: 'QUIT' },
  ];

  return new Promise((resolve, reject) => {
    const socket = connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
    const timer = setTimeout(() => fail(new Error('smtp: timed out')), TIMEOUT_MS);
    let buffer = '';
    let step = 0;

    function fail(err) {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }

    socket.on('error', fail);
    socket.on('data', (chunk) => {
      if (step >= script.length) return; // QUIT sent, ignore the goodbye
      buffer += chunk.toString('utf8');
      // A reply is complete once its final "NNN " line arrives ("NNN-" lines
      // are continuations). Everything before it belongs to the same reply.
      const done = buffer.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (!done) return;
      const code = Number(done[2]);
      const reply = buffer.trim().split(CRLF).pop() ?? '';
      buffer = '';
      const { expect, send } = script[step];
      if (code !== expect) { fail(new Error(`smtp: expected ${expect}, got "${reply}"`)); return; }
      step += 1;
      socket.write(send + CRLF);
      if (step >= script.length) {
        clearTimeout(timer);
        socket.end();
        resolve(undefined);
      }
    });
  });
}
