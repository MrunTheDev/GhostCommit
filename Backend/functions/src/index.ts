import { setGlobalOptions } from "firebase-functions";
import * as logger from "firebase-functions/logger";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

admin.initializeApp();
const db  = admin.firestore();
const msg = admin.messaging();

setGlobalOptions({ maxInstances: 10 });

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

async function getStaffContext(uid: string) {
  const snap = await db.collection("staff").doc(uid).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "Not a staff user");
  return { id: uid, ...snap.data() };
}

function buildTriagePrompt(incident: any) {
  return `A guest has reported an emergency.

Type: ${incident.type}
Location: ${incident.location}
Description: ${incident.description}

Return JSON:
{
 "severity":"LOW|MEDIUM|CRITICAL",
 "category":"MEDICAL|FIRE|SECURITY|MAINTENANCE|OTHER",
 "dispatch_message":"text",
 "action_steps":["step1"],
 "notify_roles":["SECURITY","MEDICAL","MANAGEMENT","MAINTENANCE"],
 "responder_brief":"text",
 "guest_message":"text",
 "escalate_to_112":true,
 "eta_minutes":5
}`;
}

async function callGemini(prompt: string) {
  if (!process.env.GEMINI_KEY) throw new Error("Missing GEMINI_KEY");

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function notifyStaffByRoles(roles: string[], incident: any, triage: any, incidentId: string) {
  for (const role of roles) {
    const snap = await db.collection("staff")
      .where("role", "==", role)
      .where("isOnDuty", "==", true)
      .get();

    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) continue;

    await msg.sendEachForMulticast({
      tokens,
      notification: {
        title: `${triage.severity} ALERT`,
        body: triage.dispatch_message
      },
      android: { priority: "high" },
      data: { incidentId }
    });
  }
}

// ═══════════════════════════════════════
// GUEST
// ═══════════════════════════════════════

export const triageIncident = onDocumentCreated(
  { document: "incidents/{incidentId}", secrets: ["GEMINI_KEY"] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const incident = snap.data();
    const id = event.params.incidentId;

    try {
      const triage = await callGemini(buildTriagePrompt(incident));

      await snap.ref.update({
        triage,
        status: "ACTIVE",
        assignedRoles: triage.notify_roles
      });

      await notifyStaffByRoles(triage.notify_roles, incident, triage, id);

    } catch (e) {
      await snap.ref.update({ status: "ERROR" });
    }
  }
);

// ═══════════════════════════════════════
// STAFF
// ═══════════════════════════════════════

export const claimIncident = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");

  const { incidentId } = req.data;
  const staff = await getStaffContext(req.auth.uid);

  const ref = db.collection("incidents").doc(incidentId);
  const snap = await ref.get();

  if (!snap.exists) throw new HttpsError("not-found", "Not found");

  if (snap.data()?.claimedBy) {
    throw new HttpsError("failed-precondition", "Already claimed");
  }

  await ref.update({
    claimedBy: {
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      claimedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    status: "IN_PROGRESS"
  });

  return { success: true };
});

export const addIncidentUpdate = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");

  const { incidentId, message } = req.data;
  const staff = await getStaffContext(req.auth.uid);

  const incidentSnap = await db.collection("incidents").doc(incidentId).get();
  if (!incidentSnap.exists) throw new HttpsError("not-found", "Not found");

  if (incidentSnap.data()?.hotelId !== staff.hotelId) {
    throw new HttpsError("permission-denied", "Wrong hotel");
  }

  await db.collection("incidents").doc(incidentId).collection("updates").add({
    staffId: staff.id,
    message,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true };
});

// ═══════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════

export const assignStaffToIncident = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");

  const adminUser = await getStaffContext(req.auth.uid);
  if (adminUser.role !== "MANAGEMENT") {
    throw new HttpsError("permission-denied", "Admin only");
  }

  const { incidentId, staffId } = req.data;

  await db.collection("incidents").doc(incidentId).update({
    assignedStaff: admin.firestore.FieldValue.arrayUnion({ staffId })
  });

  return { success: true };
});

// ═══════════════════════════════════════
// SCHEDULE
// ═══════════════════════════════════════

export const nightlyRiskPrediction = onSchedule(
  { schedule: "0 20 * * *", secrets: ["GEMINI_KEY"] },
  async () => {

    const hotels = await db.collection("hotels").get();

    for (const doc of hotels.docs) {
      const data = doc.data() || {};

      const hotel = {
        id: doc.id,
        name: data.name ?? data.hotelName ?? "Unknown Hotel"
      };

      await db.collection("riskPredictions").add({
        hotelId: hotel.id,
        hotelName: hotel.name,
        generatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
import * as functions from "firebase-functions";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

admin.initializeApp();
const db  = admin.firestore();
const msg = admin.messaging();

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

async function getStaffContext(uid: string) {
  const snap = await db.collection("staff").doc(uid).get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("permission-denied", "Not a staff user");
  }
  return { id: uid, ...snap.data() };
}

function buildTriagePrompt(incident: any) {
  return `A guest has reported an emergency.

Type: ${incident.type}
Location: ${incident.location}
Description: ${incident.description}

Return JSON:
{
 "severity":"LOW|MEDIUM|CRITICAL",
 "category":"MEDICAL|FIRE|SECURITY|MAINTENANCE|OTHER",
 "dispatch_message":"text",
 "action_steps":["step1"],
 "notify_roles":["SECURITY","MEDICAL","MANAGEMENT","MAINTENANCE"],
 "responder_brief":"text",
 "guest_message":"text",
 "escalate_to_112":true,
 "eta_minutes":5
}`;
}

async function callGemini(prompt: string) {
  if (!process.env.GEMINI_KEY) throw new Error("Missing GEMINI_KEY");

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function notifyStaffByRoles(
  roles: string[],
  incident: any,
  triage: any,
  incidentId: string
) {
  for (const role of roles) {
    const snap = await db.collection("staff")
      .where("role", "==", role)
      .where("isOnDuty", "==", true)
      .get();

    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) continue;

    await msg.sendEachForMulticast({
      tokens,
      notification: {
        title: `${triage.severity} ALERT`,
        body: triage.dispatch_message
      },
      android: { priority: "high" },
      data: { incidentId }
    });
  }
}

// ═══════════════════════════════════════
// GUEST
// ═══════════════════════════════════════

export const triageIncident = functions.firestore
  .document("incidents/{incidentId}")
  .onCreate(async (snap, context) => {

    const incident = snap.data();
    const incidentId = context.params.incidentId;

    try {
      const triage = await callGemini(buildTriagePrompt(incident));

      await snap.ref.update({
        triage,
        status: "ACTIVE",
        assignedRoles: triage.notify_roles
      });

      await notifyStaffByRoles(
        triage.notify_roles,
        incident,
        triage,
        incidentId
      );

    } catch (e) {
      logger.error("triage error", e);
      await snap.ref.update({ status: "ERROR" });
    }
  });

// ═══════════════════════════════════════
// STAFF
// ═══════════════════════════════════════

export const claimIncident = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const { incidentId } = data;
  const staff = await getStaffContext(context.auth.uid);

  const ref = db.collection("incidents").doc(incidentId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Not found");
  }

  if (snap.data()?.claimedBy) {
    throw new functions.https.HttpsError("failed-precondition", "Already claimed");
  }

  await ref.update({
    claimedBy: {
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      claimedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    status: "IN_PROGRESS"
  });

  return { success: true };
});

export const addIncidentUpdate = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const { incidentId, message } = data;
  const staff = await getStaffContext(context.auth.uid);

  const incidentSnap = await db.collection("incidents").doc(incidentId).get();
  if (!incidentSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Not found");
  }

  if (incidentSnap.data()?.hotelId !== staff.hotelId) {
    throw new functions.https.HttpsError("permission-denied", "Wrong hotel");
  }

  await db.collection("incidents")
    .doc(incidentId)
    .collection("updates")
    .add({
      staffId: staff.id,
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

  return { success: true };
});

// ═══════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════

export const assignStaffToIncident = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const adminUser = await getStaffContext(context.auth.uid);

  if (adminUser.role !== "MANAGEMENT") {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }

  const { incidentId, staffId } = data;

  await db.collection("incidents").doc(incidentId).update({
    assignedStaff: admin.firestore.FieldValue.arrayUnion({ staffId })
  });

  return { success: true };
}););