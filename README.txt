NOIR custom mobile + password auth bundle

Files: index.html and api/*.js plus package.json/vercel.json.

Important: This replaces the Firebase Auth token flow with custom sessions stored in Realtime Database. Keep database rules closed to client access. Required Vercel environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, optional FIREBASE_DATABASE_URL. Do not expose the private key.

Before deploying to production, test register/login/logout/profile/referral/team on a staging deployment. This custom flow does not verify ownership of a phone number because there is no OTP. Protect the endpoints with monitoring and consider a stronger abuse-control/rate-limit provider. Existing Google-auth users remain in Firebase but the new HTML does not offer Google login. Existing legacy ID tokens can still be accepted by APIs for migration compatibility.
