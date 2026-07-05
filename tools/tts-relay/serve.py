#!/usr/bin/env python3
"""Speech relay: NVIDIA-hosted Magpie TTS + Parakeet ASR (gRPC) -> local HTTP.

The hosted speech APIs are gRPC-only (grpc.nvcf.nvidia.com) so the web app
cannot call them directly; this relay exposes them as plain HTTP on localhost
for the demo (the demo runs on vite preview, same machine). The app tries this
relay first for TTS (then Vultr, then the browser voice) and uses it for the
push-to-talk voice input (ASR).

Usage:
    python serve.py            # serve on 127.0.0.1:8123
    python serve.py --probe    # verify key + list/try voices, then exit

Key: env NVIDIA_API_KEY, or NVIDIA_API_KEY=nvapi-... line in ../../.env.
Endpoints:
    GET  /health  -> {"ok": true}
    GET  /voices  -> voices reported by the service (best effort)
    POST /tts     -> body {"text": str, "lang": "en"|"fr"|...} -> audio/wav
    POST /asr?lang=en -> body = audio clip (webm/opus, wav...; ffmpeg converts)
                      -> {"text": str} via Parakeet multilingual

Voice names below follow the documented Magpie pattern
(Magpie-Multilingual.EN-US.Aria); non-EN names are unverified until --probe
runs with a real key - unknown/failing languages fall back to English.
"""
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import riva.client

PORT = 8123
NVCF_URI = 'grpc.nvcf.nvidia.com:443'
# NVIDIA's published function id for hosted magpie-tts-multilingual (from
# their voice-agent-examples); override with NVCF_FUNCTION_ID if it rotates.
FUNCTION_ID = os.environ.get('NVCF_FUNCTION_ID', '877104f7-e885-42b9-8de8-f6e4c6303969')
# ai-parakeet-1_1b-rnnt-multilingual-asr (answers in 0.5s, verified 2026-07-04)
ASR_FUNCTION_ID = os.environ.get('NVCF_ASR_FUNCTION_ID', '71203149-d3b7-4460-8231-1be2543a1fca')
SAMPLE_RATE = 22050
ASR_SAMPLE_RATE = 16000
ASR_LANGS = {'en': 'en-US', 'fr': 'fr-FR', 'es': 'es-US', 'de': 'de-DE', 'it': 'it-IT',
             'ja': 'ja-JP', 'hi': 'hi-IN', 'ar': 'ar-AR', 'ko': 'ko-KR', 'pt': 'pt-BR'}

# lang (app store code) -> (language_code, voice_name)
# Magpie Multilingual speaks 9 languages (En Es De Fr Vi It Zh Hi Ja); FR-FR
# ships a dedicated "Louise" voice (verified in NVIDIA's docs), the others use
# the shared speakers (Aria/Jason/Leo/Sofia). Failing names fall back to EN.
VOICES = {
    'en': ('en-US', 'Magpie-Multilingual.EN-US.Aria'),
    'fr': ('fr-FR', 'Magpie-Multilingual.FR-FR.Louise'),
    'es': ('es-US', 'Magpie-Multilingual.ES-US.Aria'),
    'de': ('de-DE', 'Magpie-Multilingual.DE-DE.Aria'),
    'it': ('it-IT', 'Magpie-Multilingual.IT-IT.Aria'),
    'vi': ('vi-VN', 'Magpie-Multilingual.VI-VN.Aria'),
    'zh': ('zh-CN', 'Magpie-Multilingual.ZH-CN.Aria'),
    'hi': ('hi-IN', 'Magpie-Multilingual.HI-IN.Aria'),
    'ja': ('ja-JP', 'Magpie-Multilingual.JA-JP.Aria'),
}


def load_key() -> str:
    key = os.environ.get('NVIDIA_API_KEY', '')
    if not key:
        env_file = Path(__file__).resolve().parents[2] / '.env'
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith('NVIDIA_API_KEY='):
                    key = line.split('=', 1)[1].strip()
    if not key:
        sys.exit('NVIDIA_API_KEY missing (env or app/.env). Generate one on build.nvidia.com.')
    return key


def make_service() -> riva.client.SpeechSynthesisService:
    auth = riva.client.Auth(
        uri=NVCF_URI,
        use_ssl=True,
        metadata_args=[['function-id', FUNCTION_ID], ['authorization', f'Bearer {load_key()}']],
    )
    return riva.client.SpeechSynthesisService(auth)


SERVICE = None  # lazy: first request builds it, so --probe errors stay readable


def service() -> riva.client.SpeechSynthesisService:
    global SERVICE
    if SERVICE is None:
        SERVICE = make_service()
    return SERVICE


# NVCF's gateway holds a request ~30s before "failed to establish link to
# worker" (observed 2026-07-04: both hosted Magpie functions dead while
# Parakeet ASR answered in 0.5s). The app must fall back to Vultr/browser
# fast, so /tts answers 503 immediately while the upstream is unhealthy;
# the config RPC is the health probe, cached for a minute.
HEALTH = {'ok': False, 'ts': 0.0}
HEALTH_TTL = 60.0
SYNTH_TIMEOUT = 20  # warm Magpie is sub-second; a hang must not eat the beat


def upstream_ok() -> bool:
    import time
    from riva.client.proto import riva_tts_pb2
    now = time.monotonic()
    if now - HEALTH['ts'] < HEALTH_TTL:
        return HEALTH['ok']
    try:
        service().stub.GetRivaSynthesisConfig(
            riva_tts_pb2.RivaSynthesisConfigRequest(),
            metadata=service().auth.get_auth_metadata(), timeout=5,
        )
        HEALTH.update(ok=True, ts=now)
    except Exception as err:
        print(f'[relay] upstream unhealthy: {str(err)[:120]}', flush=True)
        HEALTH.update(ok=False, ts=now)
    return HEALTH['ok']


def _synth(text: str, language_code: str, voice: str):
    from riva.client.proto import riva_tts_pb2
    req = riva_tts_pb2.SynthesizeSpeechRequest(
        text=text, voice_name=voice, language_code=language_code,
        encoding=riva.client.AudioEncoding.LINEAR_PCM, sample_rate_hz=SAMPLE_RATE,
    )
    return service().stub.Synthesize(
        req, metadata=service().auth.get_auth_metadata(), timeout=SYNTH_TIMEOUT,
    )


ASR_SERVICE = None


def asr_service() -> riva.client.ASRService:
    global ASR_SERVICE
    if ASR_SERVICE is None:
        auth = riva.client.Auth(
            uri=NVCF_URI, use_ssl=True,
            metadata_args=[['function-id', ASR_FUNCTION_ID], ['authorization', f'Bearer {load_key()}']],
        )
        ASR_SERVICE = riva.client.ASRService(auth)
    return ASR_SERVICE


def to_pcm_wav(clip: bytes) -> bytes:
    """Whatever the browser recorded (webm/opus usually) -> 16 kHz mono WAV."""
    import subprocess
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
         '-ar', str(ASR_SAMPLE_RATE), '-ac', '1', '-f', 'wav', 'pipe:1'],
        input=clip, capture_output=True, timeout=20,
    )
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f'ffmpeg: {out.stderr.decode()[:200]}')
    return out.stdout


def recognize_text(clip: bytes, lang: str) -> str:
    from riva.client.proto import riva_asr_pb2
    wav = to_pcm_wav(clip)
    req = riva_asr_pb2.RecognizeRequest(audio=wav)
    req.config.language_code = ASR_LANGS.get(lang, 'en-US')
    req.config.max_alternatives = 1
    req.config.enable_automatic_punctuation = True
    resp = asr_service().stub.Recognize(
        req, metadata=asr_service().auth.get_auth_metadata(), timeout=25,
    )
    return ' '.join(
        r.alternatives[0].transcript.strip()
        for r in resp.results if r.alternatives and r.alternatives[0].transcript.strip()
    ).strip()


def synthesize_wav(text: str, lang: str) -> bytes:
    language_code, voice = VOICES.get(lang, VOICES['en'])
    try:
        resp = _synth(text, language_code, voice)
    except Exception as err:  # unverified non-EN voice name: retry in English
        if lang == 'en':
            raise
        print(f'[relay] {lang} failed ({err}); retrying in English', flush=True)
        language_code, voice = VOICES['en']
        resp = _synth(text, language_code, voice)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(resp.audio)
    return buf.getvalue()


def list_voices():
    """Best effort: the config RPC exists on the same stub; shape varies."""
    try:
        from riva.client.proto import riva_tts_pb2
        cfg = service().stub.GetRivaSynthesisConfig(riva_tts_pb2.RivaSynthesisConfigRequest())
        out = []
        for mc in cfg.model_config:
            params = dict(mc.parameters)
            out.append({k: params[k] for k in ('voice_name', 'language_code') if k in params})
        return out
    except Exception as err:
        return {'error': str(err)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header('content-type', ctype)
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-headers', 'content-type')
        self.send_header('access-control-allow-methods', 'GET, POST, OPTIONS')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj):
        self._send(status, json.dumps(obj).encode(), 'application/json')

    def do_OPTIONS(self):
        self._send(204, b'', 'text/plain')

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'ok': True})
        elif self.path == '/voices':
            self._json(200, list_voices())
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path.startswith('/asr'):
            return self._asr()
        if self.path != '/tts':
            return self._json(404, {'error': 'not found'})
        if not upstream_ok():
            return self._json(503, {'error': 'nvcf tts workers unavailable'})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
            text = str(body.get('text', '')).strip()
            if not text:
                return self._json(400, {'error': 'text required'})
            wav = synthesize_wav(text[:500], str(body.get('lang', 'en')))
            self._send(200, wav, 'audio/wav')
        except Exception as err:
            print(f'[relay] tts failed: {err}', flush=True)
            self._json(502, {'error': str(err)})

    def _asr(self):
        from urllib.parse import parse_qs, urlparse
        try:
            clip = self.rfile.read(int(self.headers.get('content-length', 0)))
            if not clip:
                return self._json(400, {'error': 'audio required'})
            lang = parse_qs(urlparse(self.path).query).get('lang', ['en'])[0]
            text = recognize_text(clip, lang)
            print(f'[relay] asr({lang}, {len(clip)}B) -> "{text[:80]}"', flush=True)
            self._json(200, {'text': text})
        except Exception as err:
            print(f'[relay] asr failed: {err}', flush=True)
            self._json(502, {'error': str(err)})

    def log_message(self, fmt, *args):
        print(f'[relay] {self.address_string()} {fmt % args}', flush=True)


def probe():
    print(f'function-id: {FUNCTION_ID}')
    print('voices:', json.dumps(list_voices(), indent=2)[:2000])
    for lang in ('en', 'fr'):
        try:
            wav = synthesize_wav('The heating element is open circuit.', lang)
            print(f'{lang}: OK, {len(wav)} bytes of WAV')
        except Exception as err:
            print(f'{lang}: FAILED - {err}')


if __name__ == '__main__':
    if '--probe' in sys.argv:
        probe()
    else:
        print(f'[relay] Magpie TTS relay on http://127.0.0.1:{PORT} (function-id {FUNCTION_ID})', flush=True)
        ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
