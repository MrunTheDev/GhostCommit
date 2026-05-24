// ============================================================
//  CrisisSync — Complete Backend (FINAL VERSION)
//  Firebase Functions v2 + Gemini 1.5 Pro + Cloudinary + FCM
//  Node 20 Compatible
// ============================================================

"use strict";

// ─────────────────────────────────────────────────────────────
//  STEP 1: IMPORTS
//  These lines load all the tools your backend needs
// ─────────────────────────────────────────────────────────────

// Firebase Functions v2 — triggers for Firestore events
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");

// Firebase Functions v2 — scheduled (cron) jobs
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Firebase Functions — secret key manager
const { defineSecret } = require("firebase-functions/params");

// Firebase Admin SDK — talks to Firestore, FCM, Auth
const admin = require("firebase-admin");

// Google Gemini AI
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Cloudinary — photo/file storage
const cloudinary = require("cloudinary").v2;

// ─────────────────────────────────────────────────────────────
//  STEP 2: START FIREBASE
//  This one line connects your code to your Firebase project
// ─────────────────────────────────────────────────────────────

admin.initializeApp();

// ─────────────────────────────────────────────────────────────
//  STEP 3: SECRET KEY REFERENCES
//  These are NOT the actual keys — just name references
//  Firebase automatically injects the real values at runtime
//  You stored these using: firebase functions:secrets:set NAME
// ─────────────────────────────────────────────────────────────

const GEMINI_KEY            = defineSecret("GEMINI_KEY");
const CLOUDINARY_CLOUD_NAME = defineSecret("CLOUDINARY_CLOUD_NAME");
const CLOUDINARY_API_KEY    = defineSecret("CLOUDINARY_API_KEY");
const CLOUDINARY_API_SECRET = defineSecret("CLOUDINARY_API_SECRET");

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 1: triageIncident
//
//  WHAT IT DOES:
//  - Runs automatically the moment a guest submits an SOS
//  - If guest sent a photo → uploads it to Cloudinary
//  - Calls Gemini AI with the incident details
//  - Gemini decides: severity, which staff to alert, message
//  - Saves the triage result back to Firestore
//  - Sends push notifications to on-duty staff via FCM
//
//  TRIGGER: New document created in "incidents" collection
//
// ═════════════════════════════════════════════════════════════

exports.triageIncident = onDocumentCreated(
  {
    document       : "incidents/{incidentId}",
    region         : "asia-south1",   // Mumbai server — fastest for India
    timeoutSeconds : 120,             // give Gemini up to 2 minutes
    secrets        : [
      GEMINI_KEY,
      CLOUDINARY_CLOUD_NAME,
      CLOUDINARY_API_KEY,
      CLOUDINARY_API_SECRET,
    ],
  },

  async (event) => {

    // Get the newly created Firestore document
    const snap = event.data;
    if (!snap) {
      console.log("No data in event — skipping");
      return;
    }

    const incident   = snap.data();       // all the fields guest submitted
    const incidentId = event.params.incidentId;  // the document ID
    const db         = admin.firestore(); // database connection

    console.log("========================================");
    console.log("NEW INCIDENT:", incidentId);
    console.log("Type:", incident.type);
    console.log("Location:", incident.location);
    console.log("========================================");

    // ── A. SET UP CLOUDINARY ─────────────────────────────────
    // This MUST be inside the function (not outside)
    // because secrets are only available when function runs
    cloudinary.config({
      cloud_name : CLOUDINARY_CLOUD_NAME.value(),
      api_key    : CLOUDINARY_API_KEY.value(),
      api_secret : CLOUDINARY_API_SECRET.value(),
    });

    // ── B. UPLOAD PHOTO TO CLOUDINARY (if guest sent one) ────
    let photoUrl = null;

    if (incident.photoBase64) {
      console.log("Photo detected — uploading to Cloudinary...");

      try {
        const uploadResult = await cloudinary.uploader.upload(
          "data:image/jpeg;base64," + incident.photoBase64,
          {
            folder        : "crisissync/incidents",  // folder in Cloudinary
            public_id     : incidentId,              // filename = incident ID
            resource_type : "image",
            transformation: [
              { width: 1200, crop: "limit" },        // max width 1200px
              { quality: "auto" },                   // auto compress
            ],
          }
        );

        photoUrl = uploadResult.secure_url;
        console.log("Photo uploaded successfully:", photoUrl);

        // Save Cloudinary URL to Firestore
        // AND delete the heavy base64 data (can be 2-3 MB — wastes space)
        await snap.ref.update({
          photoUrl    : photoUrl,
          photoBase64 : admin.firestore.FieldValue.delete(),
        });

      } catch (uploadErr) {
        // If photo upload fails, we continue anyway
        // The SOS triage is more important than the photo
        console.error("Cloudinary failed (continuing without photo):", uploadErr.message);
      }

    } else {
      console.log("No photo in this incident — skipping Cloudinary");
    }

    // ── C. CALL GEMINI AI FOR TRIAGE ─────────────────────────
    console.log("Calling Gemini AI...");

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // This is what we send to Gemini
    // We tell it EXACTLY what format to reply in (JSON only)
    const triagePrompt = `
You are CrisisSync, an AI emergency coordinator for a hospitality venue.
Analyze the incident below and return a triage decision.

CRITICAL RULE: Reply with ONLY a raw JSON object.
No explanation. No markdown. No backticks. Just the JSON starting with { and ending with }.

INCIDENT DETAILS:
- Type: ${incident.type || "Unknown"}
- Location: ${incident.location || "Unknown"}  
- Description: ${incident.description || "No description provided"}
- Hotel ID: ${incident.hotelId || "Unknown"}
- Photo attached: ${photoUrl ? "Yes — " + photoUrl : "No"}
- Reported at: ${new Date().toISOString()}

RESPOND WITH THIS EXACT JSON STRUCTURE:
{
  "severity": "LOW" or "MEDIUM" or "CRITICAL",
  "category": "MEDICAL" or "FIRE" or "SECURITY" or "MAINTENANCE" or "OTHER",
  "dispatch_message": "A clear 2-sentence alert message for responding staff",
  "action_steps": ["Immediate action 1", "Immediate action 2", "Immediate action 3"],
  "notify_roles": ["Security"] or ["Medical"] or ["Security", "Medical", "Management"],
  "guest_message": "A calm reassuring message to display to the distressed guest",
  "escalate_to_112": true or false,
  "eta_minutes": estimated staff arrival time as a number
}`;

    try {
      // Send prompt to Gemini and get response
      const geminiResult = await model.generateContent(triagePrompt);
      const rawResponse  = geminiResult.response.text().trim();

      console.log("Gemini raw response (first 300 chars):");
      console.log(rawResponse.substring(0, 300));

      // Clean response in case Gemini accidentally added ```json ... ```
      const cleanedResponse = rawResponse
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      // Parse the JSON
      const triage = JSON.parse(cleanedResponse);

      console.log("Triage severity:", triage.severity);
      console.log("Notify roles:", triage.notify_roles);
      console.log("Escalate to 112:", triage.escalate_to_112);

      // ── D. SAVE TRIAGE RESULT TO FIRESTORE ───────────────────
      await snap.ref.update({
        triage            : triage,
        status            : "ACTIVE",
        photoUrl          : photoUrl || null,
        triageCompletedAt : admin.firestore.FieldValue.serverTimestamp(),
        triageError       : false,
      });

      console.log("Triage saved to Firestore successfully");

      // ── E. SEND FCM PUSH NOTIFICATIONS TO STAFF ──────────────
      await notifyStaff(
        triage.notify_roles,
        incident,
        triage,
        incidentId,
        db
      );

      console.log("triageIncident completed successfully for:", incidentId);

    } catch (geminiErr) {
      // Gemini failed — but we still mark incident ACTIVE
      // so staff can manually see it in the dashboard
      console.error("Gemini triage failed:", geminiErr.message);

      await snap.ref.update({
        status         : "ACTIVE",
        triageError    : true,
        triageErrorMsg : geminiErr.message,
        photoUrl       : photoUrl || null,
      });
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  HELPER FUNCTION: notifyStaff
//
//  WHAT IT DOES:
//  - Takes the list of roles Gemini said to notify
//    e.g. ["Security", "Medical"]
//  - For each role, finds all staff who are on duty
//  - Collects their FCM tokens (phone notification addresses)
//  - Sends a high-priority push notification to each phone
//
//  This is NOT exported — it's only called by triageIncident
//
// ═════════════════════════════════════════════════════════════

async function notifyStaff(roles, incident, triage, incidentId, db) {

  const messaging = admin.messaging();

  // Loop through each role Gemini said to notify
  for (const role of roles) {
    console.log("Searching for on-duty staff with role:", role);

    // Query Firestore: find staff with this role who are on duty
    const staffSnapshot = await db
      .collection("staff")
      .where("role",     "==", role)
      .where("isOnDuty", "==", true)
      .get();

    if (staffSnapshot.empty) {
      console.log("No on-duty staff found for role:", role);
      continue; // skip to next role
    }

    // Collect all their FCM tokens
    // FCM token = a unique address for each phone/device
    const tokens = staffSnapshot.docs
      .map((doc) => doc.data().fcmToken)
      .filter((token) => token && token.length > 10); // remove empty/invalid tokens

    if (tokens.length === 0) {
      console.log("Staff found but no valid FCM tokens for role:", role);
      continue;
    }

    console.log("Sending push notification to", tokens.length, role, "staff...");

    // Send the push notification to all their phones at once
    try {
      const response = await messaging.sendEachForMulticast({
        tokens : tokens,

        notification: {
          title: "ALERT " + triage.severity + ": " + (incident.type || "Emergency"),
          body  : triage.dispatch_message,
        },

        android: {
          priority: "high",             // wakes phone even if on silent
          notification: {
            sound     : "default",
            channelId : "crisis_alerts",
            priority  : "max",
          },
        },

        // Extra data sent with notification (for the Flutter app to use)
        data: {
          incidentId : incidentId,
          severity   : triage.severity,
          location   : incident.location || "",
          type       : incident.type     || "",
          photoUrl   : incident.photoUrl || "",
        },
      });

      console.log("FCM sent successfully to", role);
      console.log("Success count:", response.successCount);
      console.log("Failure count:", response.failureCount);

    } catch (fcmErr) {
      console.error("FCM failed for role:", role, fcmErr.message);
    }
  }
}

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 2: generateResponderBrief
//
//  WHAT IT DOES:
//  - Runs when an admin taps "Escalate to Emergency Services"
//  - This flips incident.escalated from false to true
//  - Gemini generates a professional brief for 112/ambulance/fire
//  - Brief includes exact location, hazards, access routes etc.
//
//  TRIGGER: incident document updated + escalated = true
//
// ═════════════════════════════════════════════════════════════

exports.generateResponderBrief = onDocumentUpdated(
  {
    document : "incidents/{incidentId}",
    region   : "asia-south1",
    secrets  : [GEMINI_KEY],
  },

  async (event) => {

    const before = event.data.before.data(); // document BEFORE the update
    const after  = event.data.after.data();  // document AFTER the update

    // Only run when escalated changes from false → true
    // If escalated didn't change, exit immediately
    if (before.escalated === after.escalated) return;
    if (!after.escalated) return;

    console.log("========================================");
    console.log("INCIDENT ESCALATED — generating responder brief");
    console.log("Incident ID:", event.params.incidentId);
    console.log("========================================");

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const briefPrompt = `
You are CrisisSync generating an emergency brief for first responders.
This will be read by ambulance crews, firefighters, and police.
It must be clear, precise, and professional.

CRITICAL RULE: Reply with ONLY raw JSON. No markdown. No extra text.

INCIDENT DATA:
${JSON.stringify(after, null, 2)}

RETURN THIS JSON:
{
  "incident_summary": "One clear paragraph describing the full emergency situation",
  "exact_location": "Precise location including building, floor, room, and landmarks",
  "access_route": "Best entry point and route for emergency vehicles",
  "number_affected": estimated number of people affected as integer,
  "medical_notes": "Relevant medical information, conditions, allergies if known",
  "hazards": "Any fire, chemical, structural, or electrical hazards",
  "recommended_units": "Which units to dispatch e.g. 1 ambulance, 2 police",
  "priority_level": "P1" or "P2" or "P3"
}`;

    try {
      const result = await model.generateContent(briefPrompt);
      const raw    = result.response.text().trim()
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const brief = JSON.parse(raw);

      await event.data.after.ref.update({
        responderBrief            : brief,
        responderBriefGeneratedAt : admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("Responder brief saved successfully");

    } catch (err) {
      console.error("Responder brief generation failed:", err.message);
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 3: generatePostIncidentSummary
//
//  WHAT IT DOES:
//  - Runs when staff marks an incident as RESOLVED
//  - Gemini writes a full incident report
//  - Report is used by management and insurance
//  - Includes timeline, effectiveness assessment, recommendations
//
//  TRIGGER: incident.status changes to "RESOLVED"
//
// ═════════════════════════════════════════════════════════════

exports.generatePostIncidentSummary = onDocumentUpdated(
  {
    document : "incidents/{incidentId}",
    region   : "asia-south1",
    secrets  : [GEMINI_KEY],
  },

  async (event) => {

    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Only run when status changes TO "RESOLVED"
    if (before.status === after.status) return;
    if (after.status !== "RESOLVED") return;

    console.log("========================================");
    console.log("INCIDENT RESOLVED — generating summary report");
    console.log("========================================");

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const summaryPrompt = `
You are CrisisSync generating a post-incident report for hotel management.
This report may be used for insurance claims, staff training, and legal records.

CRITICAL RULE: Reply with ONLY raw JSON. No markdown. No extra text.

INCIDENT DATA:
${JSON.stringify(after, null, 2)}

RETURN THIS JSON:
{
  "executive_summary": "2-3 sentences summarizing what happened and how it was resolved",
  "timeline": "Chronological timeline of events from first report to resolution",
  "response_effectiveness": "Objective assessment of how well the team handled the situation",
  "guest_impact": "Description of how hotel guests were affected",
  "recommendations": [
    "Specific recommendation 1 to prevent recurrence",
    "Specific recommendation 2 to improve response",
    "Specific recommendation 3 for staff training"
  ],
  "follow_up_required": true or false,
  "insurance_relevant": true or false,
  "severity_rating": integer from 1 (minor) to 5 (catastrophic)
}`;

    try {
      const result  = await model.generateContent(summaryPrompt);
      const raw     = result.response.text().trim()
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const summary = JSON.parse(raw);

      await event.data.after.ref.update({
        postIncidentSummary : summary,
        summaryGeneratedAt  : admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("Post-incident summary saved successfully");

    } catch (err) {
      console.error("Post-incident summary failed:", err.message);
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 4: nightlyRiskPrediction
//
//  WHAT IT DOES:
//  - Runs automatically every night at midnight IST
//  - Reads all incidents from the last 90 days
//  - Sends them to Gemini for pattern analysis
//  - Gemini predicts future risks and hotspot areas
//  - Saves predictions to each hotel's subcollection
//
//  TRIGGER: Cloud Scheduler — cron "0 0 * * *" (midnight daily)
//
// ═════════════════════════════════════════════════════════════

exports.nightlyRiskPrediction = onSchedule(
  {
    schedule : "0 0 * * *",      // midnight every day
    timeZone : "Asia/Kolkata",   // IST timezone
    region   : "asia-south1",
    secrets  : [GEMINI_KEY],
  },

  async () => {

    console.log("========================================");
    console.log("NIGHTLY RISK PREDICTION — starting");
    console.log("Time:", new Date().toISOString());
    console.log("========================================");

    const db = admin.firestore();

    // Get all hotels in the system
    const hotelsSnap = await db.collection("hotels").get();

    if (hotelsSnap.empty) {
      console.log("No hotels in database — skipping risk prediction");
      return;
    }

    console.log("Hotels found:", hotelsSnap.size);

    // Get incidents from the last 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const incidentsSnap = await db
      .collection("incidents")
      .where("createdAt", ">=", ninetyDaysAgo)
      .get();

    if (incidentsSnap.empty) {
      console.log("No incidents in last 90 days — skipping");
      return;
    }

    const incidents = incidentsSnap.docs.map((doc) => doc.data());
    console.log("Incidents analyzed:", incidents.length);

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const riskPrompt = `
You are CrisisSync analyzing 90 days of hotel incident data to predict future risks.
Use pattern recognition to identify trends and high-risk situations.

CRITICAL RULE: Reply with ONLY raw JSON. No markdown. No extra text.

HISTORICAL INCIDENT DATA (last 90 days, ${incidents.length} total incidents):
${JSON.stringify(incidents.slice(0, 40), null, 2)}

RETURN THIS JSON:
{
  "high_risk_areas": ["Specific area 1", "Specific area 2", "Specific area 3"],
  "high_risk_times": ["Friday evenings", "Early morning 2-4am", "Checkout rush"],
  "predicted_incident_types": ["MEDICAL", "SECURITY"],
  "risk_score": integer from 1 (very safe) to 100 (very dangerous),
  "recommendations": [
    "Specific actionable recommendation 1",
    "Specific actionable recommendation 2",
    "Specific actionable recommendation 3"
  ],
  "trend": "IMPROVING" or "STABLE" or "WORSENING",
  "analysis_summary": "2-3 sentence overview of patterns found"
}`;

    try {
      const result     = await model.generateContent(riskPrompt);
      const raw        = result.response.text().trim()
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const prediction = JSON.parse(raw);

      console.log("Risk score:", prediction.risk_score);
      console.log("Trend:", prediction.trend);

      // Save prediction to EVERY hotel's predictions subcollection
      const savePromises = hotelsSnap.docs.map((hotelDoc) =>
        hotelDoc.ref.collection("predictions").add({
          ...prediction,
          createdAt      : admin.firestore.FieldValue.serverTimestamp(),
          incidentsCount : incidents.length,
          periodDays     : 90,
        })
      );

      await Promise.all(savePromises);
      console.log("Risk prediction saved to all", hotelsSnap.size, "hotels");

    } catch (err) {
      console.error("Risk prediction failed:", err.message);
    }
  }
);
