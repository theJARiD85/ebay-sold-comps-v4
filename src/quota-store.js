import crypto from "node:crypto";

export class QuotaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const digest = (...parts) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
const isConflict = (error) => Number(error?.code) === 409;
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function validateState(state) {
  if (!state?.ready) {
    throw new QuotaError(
      503,
      "QUOTAS_NOT_INITIALIZED",
      "Seller quota usage must be initialized by the rollout operator.",
    );
  }

  if (
    !Number.isSafeInteger(state.activeListings) ||
    state.activeListings < 0 ||
    !Number.isSafeInteger(state.aiValuations) ||
    state.aiValuations < 0 ||
    !/^\d{4}-\d{2}$/.test(state.month)
  ) {
    throw new QuotaError(
      503,
      "QUOTA_STATE_INVALID",
      "Seller quota state requires reconciliation.",
    );
  }
}

function normalizeState(state) {
  validateState(state);
  if (state.trialAiValuations == null) state.trialAiValuations = 0;
  if (
    !Number.isSafeInteger(state.trialAiValuations) ||
    state.trialAiValuations < 0
  ) {
    throw new QuotaError(
      503,
      "QUOTA_STATE_INVALID",
      "Trial scan usage requires reconciliation.",
    );
  }
  return state;
}

export function quotaKey(value, name) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new QuotaError(
      400,
      "INVALID_QUOTA_KEY",
      `${name} must be 1-128 ASCII identifier characters.`,
    );
  }
  return value;
}

// All quota writers increment a single owner row in an Appwrite transaction
// before reading counters. That row is the deliberate concurrency boundary.
export function createQuotaStore(tables, databaseId, tableId) {
  const base = { databaseId, tableId };
  const get = async (rowId, transactionId) => {
    try {
      return await tables.getRow({
        ...base,
        rowId,
        ...(transactionId ? { transactionId } : {}),
      });
    } catch (error) {
      if (
        Number(error?.code) === 404 &&
        error?.type !== "table_not_found" &&
        error?.type !== "database_not_found"
      ) {
        return null;
      }
      throw error;
    }
  };
  const decode = (row) => (row ? JSON.parse(row.payload) : null);

  return {
    async ensure(ownerId, now = Date.now()) {
      const rowId = digest("state", ownerId);
      const initialState = {
        ready: true,
        activeListings: 0,
        aiValuations: 0,
        trialAiValuations: 0,
        month: monthOf(now),
      };

      try {
        await tables.createRow({
          ...base,
          rowId,
          data: { revision: 0, payload: JSON.stringify(initialState) },
          permissions: [],
        });
        return initialState;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }

      const state = decode(await get(rowId));
      normalizeState(state);
      return state;
    },

    async run(ownerId, work) {
      const rowId = digest("state", ownerId);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const transaction = await tables.createTransaction({ ttl: 60 });
        const transactionId = transaction.$id;
        try {
          await tables.incrementRowColumn({
            ...base,
            rowId,
            column: "revision",
            value: 1,
            transactionId,
          });
          const state = decode(await get(rowId, transactionId));
          normalizeState(state);
          const result = await work(state, {
            transactionId,
            get: async (id) => decode(await get(id, transactionId)),
            put: async (id, data, exists) => {
              const args = {
                ...base,
                rowId: id,
                data: { payload: JSON.stringify(data) },
                transactionId,
              };
              if (exists) await tables.updateRow(args);
              else {
                await tables.createRow({
                  ...args,
                  data: { ...args.data, revision: 0 },
                  permissions: [],
                });
              }
            },
          });
          await tables.updateRow({
            ...base,
            rowId,
            data: { payload: JSON.stringify(state) },
            transactionId,
          });
          await tables.updateTransaction({ transactionId, commit: true });
          return result;
        } catch (error) {
          await tables
            .updateTransaction({ transactionId, rollback: true })
            .catch(() => {});
          if (isConflict(error) && attempt < 11) {
            await sleep(Math.min(250, 5 * 2 ** attempt) + Math.random() * 30);
            continue;
          }
          if (Number(error?.code) === 404) {
            throw new QuotaError(
              503,
              "QUOTAS_NOT_INITIALIZED",
              "Seller quota storage or owner state is missing.",
            );
          }
          if (isConflict(error)) {
            throw new QuotaError(
              503,
              "QUOTA_BUSY",
              "Retry with the same operation key.",
            );
          }
          throw error;
        }
      }
      throw new QuotaError(503, "QUOTA_BUSY", "Quota storage is busy.");
    },
  };
}

export async function mutateAiQuota(
  store,
  ownerId,
  access,
  { action, operationId, resourceId },
  now = Date.now(),
) {
  if (action !== "consume" && action !== "release") {
    throw new QuotaError(400, "INVALID_QUOTA_ACTION", "Unknown quota action.");
  }

  const key = quotaKey(operationId, "operationId");
  const resource = quotaKey(resourceId, "resourceId");
  const receiptId = digest(ownerId, "ai", key);

  return store.run(ownerId, async (state, ledger) => {
    const existing = await ledger.get(receiptId);
    if (existing && existing.resourceId !== resource) {
      throw new QuotaError(
        409,
        "IDEMPOTENCY_MISMATCH",
        "Operation key belongs to a different resource.",
      );
    }

    if (action === "release") {
      if (!existing || existing.kind !== "ai") {
        throw new QuotaError(
          404,
          "AI_CONSUMPTION_NOT_FOUND",
          "AI consumption receipt not found.",
        );
      }
      if (existing.status === "released") {
        return { ok: true, replayed: true, dispatch: false, ...existing };
      }

      const field = existing.trial ? "trialAiValuations" : "aiValuations";
      const currentPaidMonth =
        existing.trial ||
        (existing.month === monthOf(now) && state.month === existing.month);
      if (currentPaidMonth) {
        if (state[field] < 1) {
          throw new QuotaError(
            503,
            "QUOTA_STATE_INVALID",
            "AI usage requires reconciliation.",
          );
        }
        state[field] -= 1;
      }
      const receipt = { ...existing, status: "released" };
      await ledger.put(receiptId, receipt, true);
      return { ok: true, replayed: false, dispatch: false, ...receipt };
    }

    if (existing) {
      return {
        ok: true,
        replayed: true,
        dispatch: false,
        ...existing,
      };
    }

    const canUseScannerFreeTier = access.scannerFree === true;
    if (!access.active && !canUseScannerFreeTier) {
      throw new QuotaError(
        403,
        "SUBSCRIPTION_REQUIRED",
        "An active seller subscription is required.",
      );
    }

    const month = monthOf(now);
    if (state.month !== month) {
      state.month = month;
      state.aiValuations = 0;
    }
    const field = access.trialSource === "profile" ? "trialAiValuations" : "aiValuations";
    const limit = access.limits.aiValuationScansPerMonth;
    if (
      limit !== null &&
      (!Number.isInteger(limit) || state[field] >= limit)
    ) {
      throw new QuotaError(
        409,
        "QUOTA_LIMIT_REACHED",
        "Seller quota limit reached.",
      );
    }

    state[field] += 1;
    const receipt = {
      operationId: key,
      resourceId: resource,
      kind: "ai",
      status: "consumed",
      month,
      trial: access.trialSource === "profile",
      usage: state[field],
      limit,
    };
    await ledger.put(receiptId, receipt, false);
    return { ok: true, replayed: false, dispatch: true, ...receipt };
  });
}
