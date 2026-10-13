NOIR Vercel starter

Files:
- index.html: existing NOIR design with Firebase Google sign-in added
- api/profile.js: backend endpoint verifying Firebase ID tokens
- database.rules.json: locked rules; no client reads/writes
- package.json and vercel.json

Before deployment:
1. Firebase Console > Authentication > Settings > Authorized domains: add the final Vercel domain (for example noir-vip.vercel.app).
2. In Vercel Project Settings > Environment Variables, set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON service-account credential for the NOIR Firebase project. Obtain it only from Google Cloud/Firebase IAM. NEVER put this credential in index.html, GitHub, or chat.
3. Deploy and test Google sign-in.
4. The profile API expects Authorization: Bearer <Firebase ID token>.
5. Keep database rules locked until a specific secure data access design is implemented and tested.

This starter does not implement deposits, withdrawals, balances, profit, or payment processing. Do not use it for real-money activity until a genuine payment provider integration, server-side verification, fraud controls, and legal review are completed.
