import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();
const database = admin.firestore();
// admin.firestore().settings({ ignoreUndefinedProperties: true });

// Create firestore user when firebase user is created
functions.auth.user().onCreate(async (user) => {
  database
    .collection("users")
    .doc(user.uid)
    .create({
      permissible_gates: {},
    })
    .catch(console.error);
});

// Accepts address from user, matches it to a gate group, and stores the
// relevant information
export const addAddress = functions.https.onCall(
  async (submitted_address, context) => {
    // Verify user is logged in
    if (!context.auth)
      return { status: "error", code: 401, message: "Not signed in" };

    // Update address data with associated gate groups
    submitted_address.associated_gate_groups = await getAssociatedGateGroups(
      submitted_address
    );

    // If no gate groups exist, send error code
    if (submitted_address.associated_gate_groups.length === 0) {
      return {
        status: "error",
        code: 406,
        message: "No associated gate group.",
      };
    }

    // Get user reference
    const user_reference = database.collection("users").doc(context.auth.uid);

    // Get the user document
    const user_document = await user_reference.get();
    // If the user doesn't exist or doesn't have permissible_gates, create it
    if (
      !user_document.exists ||
      user_document.data()?.permissible_gates == undefined
    ) {
      functions.logger.warn("CREATING USER");
      await user_reference.set({ permissible_gates: {} }, { merge: true });
    }

    const permissible_gates = [];

    // Get address reference to be created later
    const address_reference = user_reference.collection("addresses").doc();
    for (const gate_group of submitted_address.associated_gate_groups) {
      const gates_references = await gate_group.collection("gates").get();
      for (const gate of gates_references.docs) {
        permissible_gates[gate.id] = {
          address_reference: address_reference,
          gate_reference: gate.ref,
          verified: false,
        };
      }
    }

    // Add permissible gates to the user
    await user_reference.update({ ...permissible_gates });

    // Create Address document // TODO: Handle errors. not just for this, but for anything with an await
    await address_reference.create(submitted_address);

    // Create verification document
    const verification_reference = address_reference
      .collection("verifications")
      .doc();
    const verification_document = {
      created_at: Date(),
      // TODO: Use Crypto to generate an alphanumeric code
      verification_code: (Math.floor(Math.random() * 10000) + 10000)
        .toString()
        .substr(1),
    };

    await verification_reference.create(verification_document);

    return 200;
  }
);

async function getAssociatedGateGroups(address: any) {
  const gate_groups = await database.collection("gate-groups").get();
  const matched_addresses = [];
  for (const gate_group_document of gate_groups.docs) {
    const gate_group = gate_group_document.data();
    for (const permissible_address of gate_group.permissible_addresses) {
      if (
        address.postal_code === permissible_address.postal_code &&
        address.country === permissible_address.country &&
        address.thoroughfare.includes(permissible_address.thoroughfare) && // TODO: Re-enable and unit-test this one
        address.premise > permissible_address.premise_range_start &&
        address.premise < permissible_address.premise_range_stop
      ) {
        matched_addresses.push(gate_group_document.ref);
        break;
      }
    }
  }

  return matched_addresses;
}
