# RepairCenter

Manual-agnostic, document-grounded repair agent. Built for the RAISE Summit hackathon (Vultr
track, Statement Two).

A service organization drops in any repair manuals (PDFs, scans, photos, videos). The agent reads,
classifies, and auto-organizes them into a knowledge base rendered as a live galaxy. A technician
describes a fault; the agent plans, retrieves the right pages (visually, via VultronRetriever),
reads the schematics and the technician's photo (Nemotron), calls tools, and produces an adaptive,
cited, step-by-step repair tutorial with an explained confidence score.

All inference runs on Vultr Serverless Inference. Deployed on Cloudflare Pages.

## Run

```
npm install
npm run demo    # offline agent loop demo, no API key needed
npm run dev     # web app
npm test
```

Public URL: (added at first deploy)
