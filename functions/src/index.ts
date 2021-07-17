import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

admin.initializeApp();

export const addAddress = functions.https.onCall(async (address, context) => {
  if (!context.auth) {
    throw new Error("User must be authenticated to add address.");
  }

  const user = (
    await admin.firestore().collection("users").doc(context.auth.uid).get()
  ).data();

  const addresses = user!.addresses;

  addresses.add(address);
});
