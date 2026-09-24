import crypto from "node:crypto";
import { Client, TablesDB } from "node-appwrite";

import { createQuotaStore, mutateAiQuota, QuotaError } from "./quota-store.js";

const FREE_SCANNER_SCAN_LIMIT = 10;
const PLAN_LIMITS = {
  serious: { aiValuationScansPerMonth: null },
};
const ACTIVE_STATUSES = new Set(["trialing", "active"]);
const PERIOD_STATUSES = new Set(["cancelled", "billing_issue", "grace_period"]);
let tablesFactoryForTests = null;

export class EntitlementError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function text(value, maximum = 255) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function requiredEnv(name) {
  const value = text(process.env[name], 500);
  if (!value) {
    throw new EntitlementError(
      503,
      "ENTITLEMENT_CONFIGURATION_MISSING",
      `The market-research Function is missing ${name}.`,
    );
  }
  return value;
}

function optionalEnv(name, fallback) {
  return text(process.env[name], 500) || fallback;
}

function header(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) {
      return text(Array.isArray(value) ? value[0] : value, 8_000);
    }
  }
  return "";
}

function dateMs(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function isNotFound(error) {
  return Number(error?.code) === 404 || Number(error?.status) === 404;
}

function subscriptionTableId() {
  return optionalEnv("APPWRITE_USER_SUBSCRIPTIONS_TABLE_ID", "user_subscription");
}

function quotaTableId() {
  return optionalEnv("APPWRITE_SELLER_QUOTAS_TABLE_ID", "seller_quotas");
}

function tablesForFunction(headers, auth) {
  if (tablesFactoryForTests) return tablesFactoryForTests();

  const dynamicKey = header(headers, "x-appwrite-key");
  if (!dynamicKey) {
    throw new EntitlementError(
      503,
      "APPWRITE_FUNCTION_KEY_MISSING",
      "The market-research Function is missing its Appwrite dynamic API key.",
    );
  }

  return new TablesDB(
    new Client()
      .setEndpoint(auth.endpoint)
      .setProject(auth.projectId)
      .setKey(dynamicKey),
  );
}

// Test-only dependency injection. Production always creates a TablesDB client
// from the runtime's dynamic Appwrite key above.
export function setTablesFactoryForTests(factory) {
  tablesFactoryForTests = typeof factory === "function" ? factory : null;
}

function accessFromSubscription(row, now = Date.now()) {
  const plan = text(row?.plan, 32).toLowerCase();
  const entitlement = text(row?.entitlement, 64);
  const status = text(row?.status, 32).toLowerCase();
  const periodEnd = dateMs(row?.currentPeriodEndsAt);
  const planLimits =
    plan === "serious" && entitlement === "keepflip_serious"
      ? PLAN_LIMITS.serious
      : null;
  const active =
    Boolean(planLimits) &&
    (ACTIVE_STATUSES.has(status)
      ? !periodEnd || periodEnd > now
      : PERIOD_STATUSES.has(status)
        ? periodEnd > now
        : false);

  return {
    active,
    trialSource: active && row?.isTrial === true ? "store" : null,
    limits: {
      aiValuationScansPerMonth: active
        ? planLimits.aiValuationScansPerMonth
        : 0,
    },
  };
}

async function rowOrNull(tables, databaseId, tableId, rowId) {
  try {
    return await tables.getRow({ databaseId, tableId, rowId });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function accessForUser(tables, databaseId, userId) {
  const subscription = await rowOrNull(
    tables,
    databaseId,
    subscriptionTableId(),
    userId,
  );
  const subscriptionAccess = accessFromSubscription(
    subscription?.ownerId === userId ? subscription : null,
  );
  if (subscriptionAccess.active) return subscriptionAccess;

  return {
    ...subscriptionAccess,
    scannerFree: true,
    limits: { aiValuationScansPerMonth: FREE_SCANNER_SCAN_LIMIT },
  };
}

function operationIdFromBody(body) {
  const operationId = text(body?.operationId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
    throw new EntitlementError(
      400,
      "OPERATION_ID_REQUIRED",
      "Start a new KeepFlip scan so it receives a valid operation ID.",
    );
  }
  return operationId;
}

function resourceIdFor(body) {
  const input = { ...body };
  delete input.operationId;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 32);
}

// This is intentionally called by the provider Function itself. It means a
// request cannot reach SerpApi or OpenAI until the signed-in user, durable
// subscription state, and durable quota transaction all agree.
export async function reserveAiValuation({ headers, auth, body }) {
  const tables = tablesForFunction(headers, auth);
  const databaseId = optionalEnv("APPWRITE_DATABASE_ID", "keepflip");
  const access = await accessForUser(tables, databaseId, auth.callerUserId);
  if (!access.active && access.scannerFree !== true) {
    throw new EntitlementError(
      403,
      "SUBSCRIPTION_REQUIRED",
      "An active KeepFlip subscription is required for AI research.",
    );
  }

  const operationId = operationIdFromBody(body);
  const resourceId = resourceIdFor(body);
  const store = createQuotaStore(tables, databaseId, quotaTableId());
  await store.ensure(auth.callerUserId);
  const reservation = await mutateAiQuota(store, auth.callerUserId, access, {
    action: "consume",
    operationId,
    resourceId,
  });

  if (!reservation.dispatch) {
    throw new EntitlementError(
      409,
      "AI_ALREADY_CONSUMED",
      "This scan was already handled. Start a new scan instead of retrying it automatically.",
    );
  }

  return {
    async release() {
      try {
        await mutateAiQuota(store, auth.callerUserId, access, {
          action: "release",
          operationId,
          resourceId,
        });
      } catch (error) {
        // Preserve the actual provider failure. A release can be reconciled
        // safely with the same operation ID if Appwrite itself is unavailable.
        if (!(error instanceof QuotaError)) throw error;
      }
    },
  };
}
