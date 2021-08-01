import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { DocumentReference, DocumentData, FieldValue } from "@google-cloud/firestore";
import axios from "axios";

admin.initializeApp();
const database = admin.firestore();

interface HTTPResponse {
  status: string;
  code: number;
  message?: string;
}

interface Address {
  country: string;
  administrative_area: string;
  locality: string;
  postal_code: string;
  thoroughfare: string;
  unit?: string;
  premise: string;
}

// /users/{userId}/addresses/{addressId}
interface UserAddress extends Address, DocumentData {
  associated_gate_groups: DocumentReference<DocumentData>[];
}

// /users/{userId}
interface User extends DocumentData {
  // permissible_gates: Record<
  //   string,
  //   {
  //     address_reference: DocumentReference<DocumentData>;
  //     gate_reference: DocumentReference<DocumentData>;
  //     verified: boolean;
  //   }
  // >;
  permissible_gates: {
    [key: string]: {
      address_reference: DocumentReference<DocumentData>;
      gate_reference: DocumentReference<DocumentData>;
      verified: boolean;
    };
  };
}

// /users/{userId}/addresses/{addressId}/verifications/verification-id
interface AddressVerification {
  created_at: FieldValue;
  verification_code: string;
  verified_at: FieldValue | null;
  mailed_at: FieldValue | null;
}

interface PermissibleAddress {
  administrative_area: string;
  country: string;
  locality: string;
  postal_code: string;
  premise_range_start: string;
  premise_range_stop: string;
  thoroughfare: string;
}

// /gate-groups/{gateGroupId}
interface GateGroup extends DocumentData {
  owner: {
    address: string;
    description: string;
    email: string;
    name: string;
    phone: string;
  };
  permissible_addresses: PermissibleAddress[];
}

// /gate-groups/{gateGroupId}/gates/{gateId}
interface Gate extends DocumentData {
  api_key: string;
  description: string;
  location: Location;
}

interface VerifyAddressData {
  verification_code: string;
  address_reference: DocumentReference;
}

// Create firestore user when firebase user is created
functions.auth.user().onCreate(async (user) => {
  database
    .collection("users")
    .doc(user.uid)
    .create({
      permissible_gates: {},
    })
    .catch(functions.logger.error);
});

// Takes a gate_id, verifies that user has permission to open it, and opens it
export const openGate = functions.https.onCall(async (gate_id, context): Promise<HTTPResponse> => {
  // Verify user is logged in
  if (!context.auth) return { status: "error", code: 401, message: "Not signed in" };

  // Get user and verify that it exists
  const user_reference = database.collection("users").doc(context.auth.uid);
  const user_snapshot = await user_reference.get();
  const user_data = user_snapshot.data() as User;
  if (!user_snapshot.exists || user_data === undefined) {
    functions.logger.error(`COULD NOT FIND USER FOR UID ${context.auth.uid}`);
    return { status: "error", code: 500, message: "Could not find user data. Does it exist?" };
  }

  // Make sure user is authorized to open this gate
  if (user_data.permissible_gates[gate_id].verified) {
    // Get gate document and verify it exists
    const gate_reference = user_data.permissible_gates[gate_id].gate_reference;
    const gate_snapshot = await gate_reference.get();
    const gate_data = gate_snapshot.data() as Gate;
    if (!gate_snapshot.exists || gate_data === undefined || gate_data.api_key === undefined) {
      functions.logger.error(`Could not find API key for gateId: ${gate_id}`);
      return { status: "error", code: 500, message: "Could not find API key for requested gate." };
    }

    // TODO: Open gate
    _pulseLight(gate_data.api_key.split(":")[0], gate_data.api_key.split(":")[1]);
    functions.logger.info(`OPENING GATE ${gate_id} WITH API KEY:`, gate_data.api_key);

    return { status: "success", code: 200 };
  } else {
    return { status: "error", code: 401, message: "You are not authorized to open this gate." };
  }
});

export const pulseLight = functions.https.onRequest((request, response) => {
  if (typeof request.query.label === "string" && typeof request.query.color === "string")
    _pulseLight(request.query.label, request.query.color);
  response.end();
});

function _pulseLight(light_label: string, color: string) {
  void axios.post(`https://api.lifx.com/v1/lights/label:${light_label}/effects/breathe`, `color=${color}&period=3`, {
    headers: {
      Authorization: `Bearer ${functions.config().lifx.api_key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
}

// Accepts {address_reference, verification_code} and checks to verify the address
export const verifyAddress = functions.https.onCall(
  async (submitted_data: VerifyAddressData, context): Promise<HTTPResponse> => {
    // Verify user is logged in
    if (!context.auth) return { status: "error", code: 401, message: "Not signed in" };

    // Verify submitted address reference has a valid verification document
    const verification_reference = submitted_data.address_reference.collection("verifications").doc("verification-id");
    const verification_snapshot = await verification_reference.get();
    const verification_data = verification_snapshot.data();
    if (!verification_snapshot.exists || verification_data === undefined) {
      functions.logger.error("Could not find verification document data.");
      return { status: "error", code: 500, message: "Could not find associated verification document data." };
    }

    // Check if verification code matches
    if (
      verification_data.verification_code === submitted_data.verification_code &&
      verification_data.verified_at === null
    ) {
      // Get user and verify that it exists
      const user_reference = database.collection("users").doc(context.auth.uid);
      const user_snapshot = await user_reference.get();
      const user_data = user_snapshot.data();
      // const user_data = user_snapshot.data() as User; // TODO: make this work
      if (!user_snapshot.exists || user_data === undefined) {
        functions.logger.error(`COULD NOT FIND USER FOR UID ${context.auth.uid}`);
        return { status: "error", code: 500, message: "Could not find user data. Does it exist?" };
      }

      // Search through permissible gates on a User to figure out which one they verified and set verified to true
      for (const gate of user_data.permissible_gates) {
        if (gate.address_reference === submitted_data.address_reference) {
          gate.verified = true;
        }
      }

      // Create batch and update verification elements on User and Verification documents
      const batch = database.batch();
      batch.update(user_reference, user_data);
      batch.update(verification_reference, { verification_data: Date() });

      // Try to commit changes
      try {
        await batch.commit();
      } catch (error) {
        functions.logger.error("COULD NOT BATCH COMMIT VERIFICATION", error);
        return { status: "error", code: 500, message: "Could not commit batch writes" };
      }
      return { status: "success", code: 200, message: "Address successfully verified" };
    } else {
      // If verification code was wrong
      return { status: "invalid", code: 406, message: "Invalid verification code" };
    }
  }
);

// Accepts address from user, matches it to a gate group, and stores the
// relevant information
export const addAddress = functions.https.onCall(async (submitted_address_data, context): Promise<HTTPResponse> => {
  // Verify user is logged in
  if (!context.auth) return { status: "error", code: 401, message: "Not signed in" };

  // Get references to documents we need to touch
  const user_reference = database.collection("users").doc(context.auth.uid);
  const address_reference = user_reference.collection("addresses").doc();
  const verification_reference = address_reference.collection("verifications").doc();

  // Create data for documents we need to touch
  const address_data = await createAddressData(submitted_address_data);
  // If no gate groups were found, send error
  if (address_data.associated_gate_groups.length === 0) {
    return { status: "error", code: 406, message: "No associated gate group." };
  }
  const partial_user_data = await createPartialUserData(address_data.associated_gate_groups, address_reference);
  const verification_data = createVerificationData();

  // Create batch for all documents we need to touch
  const batch = database.batch();
  batch.set(user_reference, partial_user_data, { merge: true });
  batch.create(address_reference, address_data);
  batch.create(verification_reference, verification_data);

  // Run the batch and handle errors
  try {
    await batch.commit();
  } catch (error) {
    functions.logger.error("COULD NOT WRITE BATCH", error);
    return { status: "Internal Service Error", code: 500, message: "Could not commit batch writes" };
  }

  return { status: "success", code: 200, message: "Address matched and created." };
});

// Match gate groups to submitted address data and create relevant address data
async function createAddressData(address: Address): Promise<UserAddress> {
  // Create address data
  const associated_gate_groups = await getAssociatedGateGroups(address);
  return { associated_gate_groups, ...address };
}

// Create permissible_gates property on user object that contains all
// associated_gate_groups and the address_reference they're associated with
async function createPartialUserData(
  associated_gate_groups_references: DocumentReference<DocumentData>[],
  address_reference: DocumentReference<DocumentData>
): Promise<User> {
  const partial_user_data: User = { permissible_gates: {} };
  for (const gate_group_reference of associated_gate_groups_references) {
    const gates = await gate_group_reference.collection("gates").get();
    for (const gate of gates.docs) {
      partial_user_data.permissible_gates[gate.id] = {
        address_reference: address_reference,
        gate_reference: gate.ref,
        verified: false,
      };
    }
  }
  return partial_user_data;
}

// Create verification data
function createVerificationData(): AddressVerification {
  return {
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    verification_code: (Math.floor(Math.random() * 10000) + 10000).toString().substr(1),
    verified_at: null,
    mailed_at: null,
  };
}

// Search all gate groups to see which ones can be associated with address,
// return an array of gate group document references
async function getAssociatedGateGroups(address: Address) {
  const gate_groups = await database.collection("gate-groups").get();
  const matched_addresses = [];
  for (const gate_group of gate_groups.docs) {
    const gate_group_data = gate_group.data() as GateGroup;
    for (const permissible_address of gate_group_data.permissible_addresses) {
      if (
        address.postal_code === permissible_address.postal_code &&
        address.country === permissible_address.country &&
        address.thoroughfare.includes(permissible_address.thoroughfare) &&
        address.premise > permissible_address.premise_range_start &&
        address.premise < permissible_address.premise_range_stop
      ) {
        matched_addresses.push(gate_group.ref);
        break;
      }
    }
  }

  return matched_addresses;
}
