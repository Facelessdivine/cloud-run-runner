import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();

export async function claimShard(jobId, tests, totalTasks) {
  const jobRef = db.collection("pw-jobs").doc(jobId);
  const shardSize = Math.ceil(tests.length / totalTasks);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    const cursor = snap.exists ? snap.data().cursor || 0 : 0;

    if (cursor >= tests.length) return [];

    const start = cursor;
    const end = Math.min(start + shardSize, tests.length);

    tx.set(jobRef, { cursor: end }, { merge: true });

    return tests.slice(start, end);
  });
}
