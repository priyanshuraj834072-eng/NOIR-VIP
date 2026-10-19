import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";
import {
  db,
  sha256,
  getAuthenticatedUser
} from "./_auth.js";

const scrypt = promisify(scryptCallback);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// Sirf Gmail. a.b@gmail.com, ab+1@gmail.com aur ab@googlemail.com ek hi inbox hain,
// isliye sab ko ek hi "ab@gmail.com" maana jaata hai (ek inbox se anginat account na ban sakein).
function normalizeGmail(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw.length > 254) return null;
  const m = raw.match(/^([a-z0-9.]+)(\+[^@\s]*)?@(gmail\.com|googlemail\.com)$/);
  if (!m) return null;
  const local = m[1].replace(/\./g, "");
  if (!/^[a-z0-9]{6,30}$/.test(local)) return null;
  return local + "@gmail.com";
}

function typedEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

async function passwordDigest(password, salt) {
  return (await scrypt(password, salt, 64)).toString("hex");
}

function clientIp(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  )
    .split(",")[0]
    .trim()
    .slice(0, 100);
}

async function rateLimit(database, path, ip, limit) {
  const ref = database.ref(`${path}/${sha256(ip)}`);
  const now = Date.now();

  const tx = await ref.transaction((current) => {
    if (
      !current ||
      now - Number(current.windowStart || 0) > 15 * 60 * 1000
    ) {
      return {
        windowStart: now,
        count: 1
      };
    }

    if (Number(current.count || 0) >= limit) return;

    return {
      windowStart: current.windowStart,
      count: Number(current.count || 0) + 1
    };
  });

  return tx.committed;
}

function makeNoirId() {
  return "NR-" + randomBytes(6).toString("hex").toUpperCase();
}

async function reserveNoirId(database, uid) {
  for (let i = 0; i < 8; i++) {
    const id = makeNoirId();

    const tx = await database
      .ref(`publicIdIndex/${id}`)
      .transaction((current) =>
        current === null ? uid : undefined
      );

    if (
      tx.committed &&
      tx.snapshot.val() === uid
    ) {
      return id;
    }
  }

  throw new Error("Could not allocate a unique NOIR ID");
}

async function register(req, res) {
  const email = normalizeGmail(req.body?.email);

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!email) {
    return res.status(400).json({
      success: false,
      error:
        "Enter a valid Gmail address (like name@gmail.com)."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      success: false,
      error: "Password must be 8–128 characters."
    });
  }

  const database = db();

  if (
    !(await rateLimit(
      database,
      "registrationRateLimits",
      clientIp(req),
      10
    ))
  ) {
    return res.status(429).json({
      success: false,
      error:
        "Too many registration attempts. Try again in 15 minutes."
    });
  }

  const emailHash = sha256(email);
  const emailIndexRef =
    database.ref(`emailIndex/${emailHash}`);

  const uid =
    "nr_" + randomBytes(16).toString("hex");

  const reserve = await emailIndexRef.transaction(
    (current) =>
      current === null ? uid : undefined
  );

  if (!reserve.committed) {
    return res.status(409).json({
      success: false,
      error:
        "This Gmail already has an account. Please sign in."
    });
  }

  let noirId = null;

  try {
    noirId = await reserveNoirId(
      database,
      uid
    );

    const salt = randomBytes(16).toString("hex");
    const passwordHash =
      await passwordDigest(password, salt);

    const now = Date.now();

    const profile = {
      uid,
      email: typedEmail(req.body?.email),
      noirId,
      name: "NOIR Member",
      createdAt: now,
      lastSeenAt: now,
      status: "active",
      authType: "custom"
    };

    await database.ref().update({
      [`users/${uid}`]: profile,

      [`authCredentials/${uid}`]: {
        salt,
        passwordHash,
        passwordScheme: "scrypt-64-v1",
        createdAt: now
      },

      [`publicIdIndex/${noirId}`]: uid
    });

    const sessionToken =
      randomBytes(32).toString("base64url");

    const tokenHash =
      sha256(sessionToken);

    await database
      .ref(`authSessions/${tokenHash}`)
      .set({
        uid,
        createdAt: now,
        expiresAt: now + SESSION_MS,
        ipHash: sha256(clientIp(req))
      });

    return res.status(201).json({
      success: true,
      sessionToken,
      profile: {
        uid,
        name: profile.name,
        email: profile.email,
        noirId,
        createdAt: now,
        status: "active"
      }
    });
  } catch (error) {
    console.error(
      "NOIR registration failed:",
      error.code ||
        error.message ||
        "unknown"
    );

    const current =
      await emailIndexRef.get().catch(() => null);

    if (current?.val() === uid) {
      await emailIndexRef
        .remove()
        .catch(() => {});
    }

    if (noirId) {
      const idRef =
        database.ref(`publicIdIndex/${noirId}`);

      const idSnap =
        await idRef.get().catch(() => null);

      if (idSnap?.val() === uid) {
        await idRef.remove().catch(() => {});
      }
    }

    await database
      .ref(`users/${uid}`)
      .remove()
      .catch(() => {});

    await database
      .ref(`authCredentials/${uid}`)
      .remove()
      .catch(() => {});

    return res.status(500).json({
      success: false,
      error:
        "Could not create your account. Please try again."
    });
  }
}

async function login(req, res) {
  const email = normalizeGmail(req.body?.email);

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (
    !email ||
    !password ||
    password.length > 128
  ) {
    return res.status(400).json({
      success: false,
      error:
        "Enter a valid Gmail address and password."
    });
  }

  const database = db();

  if (
    !(await rateLimit(
      database,
      "loginRateLimits",
      clientIp(req),
      20
    ))
  ) {
    return res.status(429).json({
      success: false,
      error:
        "Too many login attempts. Try again in 15 minutes."
    });
  }

  const uid = (
    await database
      .ref(`emailIndex/${sha256(email)}`)
      .get()
  ).val();

  if (!uid) {
    return res.status(401).json({
      success: false,
      error:
        "Email or password is incorrect."
    });
  }

  const [
    credentialSnap,
    profileSnap
  ] = await Promise.all([
    database
      .ref(`authCredentials/${uid}`)
      .get(),

    database
      .ref(`users/${uid}`)
      .get()
  ]);

  if (
    !credentialSnap.exists() ||
    !profileSnap.exists()
  ) {
    return res.status(401).json({
      success: false,
      error:
        "Email or password is incorrect."
    });
  }

  const credential =
    credentialSnap.val();

  if (
    credential.passwordScheme !==
      "scrypt-64-v1" ||
    !credential.salt ||
    !credential.passwordHash
  ) {
    return res.status(401).json({
      success: false,
      error:
        "Account credentials need support. Contact NOIR support."
    });
  }

  const calculated =
    await passwordDigest(
      password,
      credential.salt
    );

  const a = Buffer.from(
    calculated,
    "hex"
  );

  const b = Buffer.from(
    String(credential.passwordHash),
    "hex"
  );

  if (
    a.length !== b.length ||
    !timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      success: false,
      error:
        "Email or password is incorrect."
    });
  }

  const profile =
    profileSnap.val();

  if (profile.status !== "active") {
    return res.status(403).json({
      success: false,
      error:
        "This account is not active."
    });
  }

  const now = Date.now();

  const sessionToken =
    randomBytes(32).toString("base64url");

  await database
    .ref(
      `authSessions/${sha256(sessionToken)}`
    )
    .set({
      uid,
      createdAt: now,
      expiresAt: now + SESSION_MS,
      ipHash: sha256(clientIp(req))
    });

  await database
    .ref(`users/${uid}/lastSeenAt`)
    .set(now);

  return res.status(200).json({
    success: true,
    sessionToken,
    profile: {
      uid,
      name: profile.name || "NOIR Member",
      email: profile.email || typedEmail(req.body?.email),
      noirId: profile.noirId,
      createdAt: profile.createdAt,
      status: profile.status
    }
  });
}

// Logged-in user ka password badalna (purana password dena zaroori)
async function changePassword(req, res) {
  const auth = await getAuthenticatedUser(req);

  if (!auth || !auth.uid) {
    return res.status(401).json({
      success: false,
      error: "Please sign in again."
    });
  }

  if (auth.authType !== "custom") {
    return res.status(400).json({
      success: false,
      error: "Password change is not available for this account."
    });
  }

  const currentPassword =
    typeof req.body?.currentPassword === "string"
      ? req.body.currentPassword
      : "";

  const newPassword =
    typeof req.body?.newPassword === "string"
      ? req.body.newPassword
      : "";

  if (!currentPassword || currentPassword.length > 128) {
    return res.status(400).json({
      success: false,
      error: "Enter your current password."
    });
  }

  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({
      success: false,
      error: "New password must be 8–128 characters."
    });
  }

  if (newPassword === currentPassword) {
    return res.status(400).json({
      success: false,
      error: "New password must be different from the current one."
    });
  }

  const database = db();

  // Har user ke liye 15 minute me sirf 5 koshish (galat password se guess rokne ke liye)
  if (
    !(await rateLimit(
      database,
      "passwordChangeRateLimits",
      auth.uid,
      5
    ))
  ) {
    return res.status(429).json({
      success: false,
      error: "Too many attempts. Try again in 15 minutes."
    });
  }

  const credentialRef = database.ref(`authCredentials/${auth.uid}`);
  const credentialSnap = await credentialRef.get();

  if (!credentialSnap.exists()) {
    return res.status(400).json({
      success: false,
      error: "Password change is not available for this account."
    });
  }

  const credential = credentialSnap.val();

  if (
    credential.passwordScheme !== "scrypt-64-v1" ||
    !credential.salt ||
    !credential.passwordHash
  ) {
    return res.status(400).json({
      success: false,
      error: "Account credentials need support. Contact NOIR support."
    });
  }

  const calculated = await passwordDigest(currentPassword, credential.salt);
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(String(credential.passwordHash), "hex");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({
      success: false,
      error: "Current password is incorrect."
    });
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = await passwordDigest(newPassword, salt);

  await credentialRef.update({
    salt,
    passwordHash,
    passwordScheme: "scrypt-64-v1",
    updatedAt: Date.now()
  });

  return res.status(200).json({
    success: true,
    message: "Password updated."
  });
}

async function logout(req, res) {
  const match = String(
    req.headers.authorization || ""
  ).match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(200).json({
      success: true
    });
  }

  const token = match[1].trim();

  if (token) {
    await db()
      .ref(`authSessions/${sha256(token)}`)
      .remove();
  }

  return res.status(200).json({
    success: true
  });
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, private"
  );

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const action = String(
      req.body?.action || ""
    ).trim().toLowerCase();

    if (action === "register") {
      return await register(req, res);
    }

    if (action === "login") {
      return await login(req, res);
    }

    if (action === "logout") {
      return await logout(req, res);
    }

    if (action === "changepassword") {
      return await changePassword(req, res);
    }

    return res.status(400).json({
      success: false,
      error:
        "Invalid action. Use register, login or logout."
    });
  } catch (error) {
    console.error(
      "NOIR auth error:",
      error.code ||
        error.message ||
        "unknown"
    );

    return res.status(500).json({
      success: false,
      error: "Authentication service error"
    });
  }
}
