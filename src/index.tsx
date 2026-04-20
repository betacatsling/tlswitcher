import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Form,
  Icon,
  List,
  Toast,
  open,
  showToast,
  useNavigation,
} from "@raycast/api";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { useCallback, useEffect, useMemo, useState } from "react";

const execFileAsync = promisify(execFile);

const APP_NAME = "Typeless";
const HOME_DIR = os.homedir();
const APP_SUPPORT_DIR = path.join(HOME_DIR, "Library", "Application Support");
const ACTIVE_DIR = path.join(APP_SUPPORT_DIR, "Typeless");
const ACTIVE_STORAGE_FILE = path.join(ACTIVE_DIR, "app-storage.json");
const DEVICE_CACHE_FILE = path.join(
  APP_SUPPORT_DIR,
  "now.typeless.desktop",
  "device.cache",
);
const STORE_ROOT = path.join(HOME_DIR, ".typeless-switcher");
const SLOTS_DIR = path.join(STORE_ROOT, "slots");
const CURRENT_SLOT_FILE = path.join(STORE_ROOT, "current-slot");
const PENDING_ADD_DIR = path.join(STORE_ROOT, "pending-add");
const PENDING_ADD_ACTIVE_DIR = path.join(PENDING_ADD_DIR, "Typeless");
const PENDING_ADD_DEVICE_CACHE_FILE = path.join(
  PENDING_ADD_DIR,
  "now.typeless.desktop",
  "device.cache",
);
const RSYNC_BIN = "/usr/bin/rsync";
const OPEN_BIN = "/usr/bin/open";
const OSASCRIPT_BIN = "/usr/bin/osascript";
const PGREP_BIN = "/usr/bin/pgrep";
const ACTIVE_REFRESH_TIMEOUT_MS = 3500;
const ACTIVE_REFRESH_POLL_MS = 500;

const RSYNC_ARGS = [
  "--archive",
  "--delete",
  "--human-readable",
  "--exclude",
  "Cache",
  "--exclude",
  "Code Cache",
  "--exclude",
  "Crashpad",
  "--exclude",
  "Logs",
  "--exclude",
  "Recordings",
  "--exclude",
  "SingletonCookie",
  "--exclude",
  "SingletonLock",
  "--exclude",
  "SingletonSocket",
];

const VOLATILE_DIRECTORIES = [
  "Cache",
  "Code Cache",
  "Crashpad",
  "Logs",
  "Recordings",
];
const VOLATILE_FILES = ["SingletonCookie", "SingletonLock", "SingletonSocket"];

type QuotaEntry = {
  usage?: number;
  limit?: number;
  available?: number;
};

type StorageShape = {
  userData?: {
    user_id?: string;
    email?: string;
    name?: string | null;
    role?: {
      name?: string;
    } | null;
    subscription_plan_name?: string | null;
    subscription_status?: string | null;
    subscription_platform?: string | null;
    payment_method?: string | null;
    current_period_end?: string | null;
    cash_credit_balance?: number | null;
  };
  quotaUsage?: Record<string, QuotaEntry | null>;
};

type AccountRecord = {
  key: string;
  userId: string;
  email: string;
  name?: string;
  slotName?: string;
  trackedSlot?: string;
  isCurrent: boolean;
  isTrackedCurrent: boolean;
  storagePath: string;
  sourceLabel: string;
  lastUpdatedLabel?: string;
  plan: string;
  role: string;
  subscriptionStatus: string;
  subscriptionPlatform?: string;
  paymentMethod?: string;
  currentPeriodEnd?: string;
  credits: number;
  quotas: {
    dailyRequests?: QuotaEntry;
    weeklyWords?: QuotaEntry;
    monthlyRequests?: QuotaEntry;
    monthlyWords?: QuotaEntry;
  };
};

type Model = {
  current?: AccountRecord;
  saved: AccountRecord[];
};

type SaveSlotFormProps = {
  defaultValue: string;
  onSave: (slotName: string) => Promise<void>;
};

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function getNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function sanitizeSlotName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || "account";
}

function sameAccount(left: AccountRecord, right: AccountRecord): boolean {
  if (left.userId && right.userId) {
    return left.userId === right.userId;
  }

  return left.email === right.email;
}

function quotaSummary(entry?: QuotaEntry): string {
  if (!entry || entry.usage === undefined || entry.limit === undefined) {
    return "n/a";
  }

  return `${entry.usage}/${entry.limit}`;
}

function quotaPercent(entry: QuotaEntry): number {
  if (!entry.limit || entry.limit <= 0 || entry.usage === undefined) {
    return 0;
  }

  return Math.round(Math.max(0, Math.min(1, entry.usage / entry.limit)) * 100);
}

function quotaColor(percent: number): Color {
  if (percent >= 80) {
    return Color.Red;
  }

  if (percent >= 50) {
    return Color.Orange;
  }

  return Color.Green;
}

function formatQuotaNumber(value: number): string {
  return value.toLocaleString();
}

function quotaAvailable(entry: QuotaEntry): number {
  if (entry.available !== undefined) {
    return entry.available;
  }

  if (entry.usage === undefined || entry.limit === undefined) {
    return 0;
  }

  return Math.max(0, entry.limit - entry.usage);
}

function hasQuota(entry?: QuotaEntry): entry is Required<QuotaEntry> {
  if (!entry || entry.usage === undefined || entry.limit === undefined) {
    return false;
  }

  return true;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

async function readCurrentSlot(): Promise<string | undefined> {
  if (!(await exists(CURRENT_SLOT_FILE))) {
    return undefined;
  }

  const value = await fs.readFile(CURRENT_SLOT_FILE, "utf8");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function listSlots(): Promise<string[]> {
  await ensureDirectory(SLOTS_DIR);
  const entries = await fs.readdir(SLOTS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readStorage(storagePath: string): Promise<StorageShape> {
  const raw = await fs.readFile(storagePath, "utf8");
  return JSON.parse(raw) as StorageShape;
}

async function getFileTimestamp(
  targetPath: string,
): Promise<string | undefined> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.mtime.toLocaleString();
  } catch {
    return undefined;
  }
}

async function getFileMtimeMs(targetPath: string): Promise<number | undefined> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}

async function refreshActiveAccountCache(): Promise<void> {
  if (!(await exists(ACTIVE_STORAGE_FILE))) {
    return;
  }

  const previousMtime = await getFileMtimeMs(ACTIVE_STORAGE_FILE);
  await execFileAsync(OPEN_BIN, ["-g", "-j", "-a", APP_NAME]).catch(
    () => undefined,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < ACTIVE_REFRESH_TIMEOUT_MS) {
    await sleep(ACTIVE_REFRESH_POLL_MS);

    const nextMtime = await getFileMtimeMs(ACTIVE_STORAGE_FILE);
    if (
      nextMtime !== undefined &&
      previousMtime !== undefined &&
      nextMtime > previousMtime
    ) {
      return;
    }
  }
}

function buildAccountRecord({
  storage,
  storagePath,
  isCurrent,
  slotName,
  trackedSlot,
  sourceLabel,
  lastUpdatedLabel,
}: {
  storage: StorageShape;
  storagePath: string;
  isCurrent: boolean;
  slotName?: string;
  trackedSlot?: string;
  sourceLabel: string;
  lastUpdatedLabel?: string;
}): AccountRecord {
  const userData = storage.userData ?? {};
  const role = getString(userData.role?.name, "unknown");
  const email = getString(userData.email, "unknown");

  return {
    key: slotName ?? email,
    userId: getString(userData.user_id),
    email,
    name: getString(userData.name ?? undefined),
    slotName,
    trackedSlot,
    isCurrent,
    isTrackedCurrent: Boolean(isCurrent && trackedSlot),
    storagePath,
    sourceLabel,
    lastUpdatedLabel,
    plan: getString(userData.subscription_plan_name, role),
    role,
    subscriptionStatus: getString(
      userData.subscription_status,
      role === "unknown" ? "unknown" : "none",
    ),
    subscriptionPlatform: getString(userData.subscription_platform),
    paymentMethod: getString(userData.payment_method),
    currentPeriodEnd: formatDate(getString(userData.current_period_end)),
    credits: getNumber(userData.cash_credit_balance),
    quotas: {
      dailyRequests:
        storage.quotaUsage?.VOICE_TO_TEXT_DAILY_REQ_MAX_CNT ?? undefined,
      weeklyWords:
        storage.quotaUsage?.VOICE_TO_TEXT_WEEKLY_WORD_CNT ?? undefined,
      monthlyRequests:
        storage.quotaUsage?.VOICE_TO_TEXT_MONTHLY_REQ_MAX_CNT ?? undefined,
      monthlyWords:
        storage.quotaUsage?.VOICE_TO_TEXT_MONTHLY_WORD_CNT ?? undefined,
    },
  };
}

async function loadAccountFromStorage({
  storagePath,
  isCurrent,
  slotName,
  trackedSlot,
  sourceLabel,
}: {
  storagePath: string;
  isCurrent: boolean;
  slotName?: string;
  trackedSlot?: string;
  sourceLabel: string;
}): Promise<AccountRecord | undefined> {
  if (!(await exists(storagePath))) {
    return undefined;
  }

  const storage = await readStorage(storagePath);
  const lastUpdatedLabel = await getFileTimestamp(storagePath);

  return buildAccountRecord({
    storage,
    storagePath,
    isCurrent,
    slotName,
    trackedSlot,
    sourceLabel,
    lastUpdatedLabel,
  });
}

async function loadModel(): Promise<Model> {
  const trackedSlot = await readCurrentSlot();
  const current = await loadAccountFromStorage({
    storagePath: ACTIVE_STORAGE_FILE,
    isCurrent: true,
    trackedSlot,
    sourceLabel: "active Typeless cache",
  });

  const slotNames = await listSlots();
  const saved: AccountRecord[] = [];

  for (const slotName of slotNames) {
    const record = await loadAccountFromStorage({
      storagePath: path.join(
        SLOTS_DIR,
        slotName,
        "Typeless",
        "app-storage.json",
      ),
      isCurrent: false,
      slotName,
      sourceLabel: "saved account snapshot",
    });

    if (!record) {
      continue;
    }

    if (current && sameAccount(current, record)) {
      continue;
    }

    saved.push(record);
  }

  if (!current && saved.length === 0) {
    throw new Error(
      `No Typeless account data found. Open ${APP_NAME} and log in once first.`,
    );
  }

  return { current, saved };
}

async function requireActiveData(): Promise<void> {
  if (!(await exists(ACTIVE_DIR)) || !(await exists(ACTIVE_STORAGE_FILE))) {
    throw new Error(
      `Typeless data not found at ${ACTIVE_DIR}. Open ${APP_NAME} and log in once first.`,
    );
  }
}

async function setCurrentSlot(slotName: string): Promise<void> {
  await ensureDirectory(STORE_ROOT);
  await fs.writeFile(CURRENT_SLOT_FILE, `${slotName}\n`, "utf8");
}

async function validateSlotName(slotName: string): Promise<string> {
  const sanitized = sanitizeSlotName(slotName);
  if (!/^[a-z0-9._-]+$/.test(sanitized)) {
    throw new Error("Slot name must match [a-z0-9._-]+.");
  }

  return sanitized;
}

async function isTypelessRunning(): Promise<boolean> {
  try {
    await execFileAsync(PGREP_BIN, ["-x", APP_NAME]);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopTypelessIfNeeded(): Promise<boolean> {
  const wasRunning = await isTypelessRunning();
  if (!wasRunning) {
    return false;
  }

  await execFileAsync(OSASCRIPT_BIN, [
    "-e",
    `tell application "${APP_NAME}" to quit`,
  ]).catch(() => undefined);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await isTypelessRunning())) {
      return true;
    }

    await sleep(250);
  }

  throw new Error(
    `${APP_NAME} is still running. Close it manually and try again.`,
  );
}

async function reopenTypelessIfNeeded(wasRunning: boolean): Promise<void> {
  if (!wasRunning) {
    return;
  }

  await execFileAsync(OPEN_BIN, ["-a", APP_NAME]).catch(() => undefined);
}

async function cleanupVolatileFiles(): Promise<void> {
  for (const directoryName of VOLATILE_DIRECTORIES) {
    await fs.rm(path.join(ACTIVE_DIR, directoryName), {
      recursive: true,
      force: true,
    });
  }

  for (const fileName of VOLATILE_FILES) {
    await fs.rm(path.join(ACTIVE_DIR, fileName), { force: true });
  }
}

async function runRsync(source: string, destination: string): Promise<void> {
  await execFileAsync(RSYNC_BIN, [...RSYNC_ARGS, source, destination]);
}

async function syncDeviceCache(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  if (await exists(sourcePath)) {
    await ensureDirectory(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);
    return;
  }

  await fs.rm(destinationPath, { force: true });
}

async function moveDirectoryIfExists(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  if (!(await exists(sourcePath))) {
    return;
  }

  await fs.rm(destinationPath, { recursive: true, force: true });
  await ensureDirectory(path.dirname(destinationPath));
  await fs.rename(sourcePath, destinationPath);
}

async function moveFileIfExists(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  if (!(await exists(sourcePath))) {
    return;
  }

  await fs.rm(destinationPath, { force: true });
  await ensureDirectory(path.dirname(destinationPath));
  await fs.rename(sourcePath, destinationPath);
}

async function syncActiveToSlot(slotName: string): Promise<void> {
  const slotDir = path.join(SLOTS_DIR, slotName);
  const slotTypelessDir = path.join(slotDir, "Typeless");
  const slotDeviceCache = path.join(
    slotDir,
    "now.typeless.desktop",
    "device.cache",
  );

  await ensureDirectory(slotTypelessDir);
  await runRsync(`${ACTIVE_DIR}/`, `${slotTypelessDir}/`);
  await syncDeviceCache(DEVICE_CACHE_FILE, slotDeviceCache);
}

async function restoreSlotToActive(slotName: string): Promise<void> {
  const slotDir = path.join(SLOTS_DIR, slotName);
  const slotTypelessDir = path.join(slotDir, "Typeless");
  const slotDeviceCache = path.join(
    slotDir,
    "now.typeless.desktop",
    "device.cache",
  );

  if (!(await exists(slotTypelessDir))) {
    throw new Error(`Saved slot '${slotName}' does not exist.`);
  }

  await ensureDirectory(ACTIVE_DIR);
  await cleanupVolatileFiles();
  await runRsync(`${slotTypelessDir}/`, `${ACTIVE_DIR}/`);
  await syncDeviceCache(slotDeviceCache, DEVICE_CACHE_FILE);
}

async function saveCurrentAccount(slotName: string): Promise<void> {
  const sanitized = await validateSlotName(slotName);
  await requireActiveData();

  const wasRunning = await stopTypelessIfNeeded();
  try {
    await syncActiveToSlot(sanitized);
    await setCurrentSlot(sanitized);
  } finally {
    await reopenTypelessIfNeeded(wasRunning);
  }
}

async function startAddingAccount(): Promise<void> {
  await requireActiveData();

  let outgoingSlot = await readCurrentSlot();
  if (!outgoingSlot) {
    const storage = await readStorage(ACTIVE_STORAGE_FILE);
    const fallbackSlot = storage.userData?.email
      ? storage.userData.email.split("@")[0]
      : "current-account";
    outgoingSlot = sanitizeSlotName(fallbackSlot);
  }

  const wasRunning = await stopTypelessIfNeeded();
  try {
    await syncActiveToSlot(outgoingSlot);
    await setCurrentSlot(outgoingSlot);
    await fs.rm(PENDING_ADD_DIR, { recursive: true, force: true });
    await ensureDirectory(PENDING_ADD_DIR);
    await moveDirectoryIfExists(ACTIVE_DIR, PENDING_ADD_ACTIVE_DIR);
    await moveFileIfExists(DEVICE_CACHE_FILE, PENDING_ADD_DEVICE_CACHE_FILE);
    await execFileAsync(OPEN_BIN, ["-a", APP_NAME]).catch(() => undefined);
  } catch (error) {
    await reopenTypelessIfNeeded(wasRunning);
    throw error;
  }
}

async function switchAccount(slotName: string): Promise<void> {
  const sanitized = await validateSlotName(slotName);
  const slotDir = path.join(SLOTS_DIR, sanitized);

  if (!(await exists(slotDir))) {
    throw new Error(`Saved slot '${sanitized}' does not exist.`);
  }

  const outgoingSlot = await readCurrentSlot();
  const hasActiveData = await exists(ACTIVE_STORAGE_FILE);
  if (!outgoingSlot && hasActiveData) {
    throw new Error(
      "No active slot is tracked yet. Save the current account first.",
    );
  }

  const wasRunning = await stopTypelessIfNeeded();
  try {
    if (hasActiveData && outgoingSlot && outgoingSlot !== sanitized) {
      await syncActiveToSlot(outgoingSlot);
    }

    await restoreSlotToActive(sanitized);
    await setCurrentSlot(sanitized);
  } finally {
    await reopenTypelessIfNeeded(wasRunning);
  }
}

async function runWithToast<T>(
  title: string,
  task: () => Promise<T>,
): Promise<T> {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title,
  });

  try {
    const result = await task();
    toast.style = Toast.Style.Success;
    toast.title = `${title} finished`;
    return result;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = `${title} failed`;
    toast.message = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function accountAccessories(account: AccountRecord): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  if (account.isCurrent) {
    accessories.push({ tag: { value: "Current", color: Color.Green } });
  }

  if (account.slotName) {
    accessories.push({ tag: account.slotName });
  } else if (account.trackedSlot) {
    accessories.push({ tag: `slot:${account.trackedSlot}` });
  }

  accessories.push({ tag: account.plan });

  if (account.quotas.dailyRequests) {
    accessories.push({
      text: `Req ${quotaSummary(account.quotas.dailyRequests)}`,
    });
  }

  if (account.quotas.weeklyWords) {
    accessories.push({
      text: `Words ${quotaSummary(account.quotas.weeklyWords)}`,
    });
  }

  return accessories;
}

function QuotaTagList({ title, entry }: { title: string; entry?: QuotaEntry }) {
  if (!hasQuota(entry)) {
    return null;
  }

  const percent = quotaPercent(entry);
  const available = quotaAvailable(entry);

  return (
    <List.Item.Detail.Metadata.TagList title={title}>
      <List.Item.Detail.Metadata.TagList.Item
        text={`${percent}% used`}
        color={quotaColor(percent)}
      />
      <List.Item.Detail.Metadata.TagList.Item
        text={`${formatQuotaNumber(entry.usage)} / ${formatQuotaNumber(entry.limit)}`}
        color={Color.Blue}
      />
      <List.Item.Detail.Metadata.TagList.Item
        text={`${formatQuotaNumber(available)} left`}
        color={Color.SecondaryText}
      />
    </List.Item.Detail.Metadata.TagList>
  );
}

function AccountMetadata({ account }: { account: AccountRecord }) {
  return (
    <List.Item.Detail.Metadata>
      <QuotaTagList
        title="Daily Requests"
        entry={account.quotas.dailyRequests}
      />
      <QuotaTagList title="Weekly Words" entry={account.quotas.weeklyWords} />
      <QuotaTagList
        title="Monthly Requests"
        entry={account.quotas.monthlyRequests}
      />
      <QuotaTagList title="Monthly Words" entry={account.quotas.monthlyWords} />
      <List.Item.Detail.Metadata.Separator />
      <List.Item.Detail.Metadata.Label title="Email" text={account.email} />
      {account.name ? (
        <List.Item.Detail.Metadata.Label title="Name" text={account.name} />
      ) : null}
      {account.slotName ? (
        <List.Item.Detail.Metadata.Label title="Slot" text={account.slotName} />
      ) : null}
      {!account.slotName && account.trackedSlot ? (
        <List.Item.Detail.Metadata.Label
          title="Tracked Slot"
          text={account.trackedSlot}
        />
      ) : null}
      <List.Item.Detail.Metadata.Label title="Plan" text={account.plan} />
      <List.Item.Detail.Metadata.Label
        title="Subscription"
        text={account.subscriptionStatus}
      />
      {account.subscriptionPlatform ? (
        <List.Item.Detail.Metadata.Label
          title="Platform"
          text={account.subscriptionPlatform}
        />
      ) : null}
      {account.paymentMethod ? (
        <List.Item.Detail.Metadata.Label
          title="Payment"
          text={account.paymentMethod}
        />
      ) : null}
      {account.currentPeriodEnd ? (
        <List.Item.Detail.Metadata.Label
          title="Period End"
          text={account.currentPeriodEnd}
        />
      ) : null}
      <List.Item.Detail.Metadata.Label
        title="Credits"
        text={String(account.credits)}
      />
      <List.Item.Detail.Metadata.Separator />
      <List.Item.Detail.Metadata.Label
        title="Source"
        text={account.sourceLabel}
      />
      {account.lastUpdatedLabel ? (
        <List.Item.Detail.Metadata.Label
          title="Updated"
          text={account.lastUpdatedLabel}
        />
      ) : null}
      <List.Item.Detail.Metadata.Label
        title="Storage File"
        text={account.storagePath}
      />
    </List.Item.Detail.Metadata>
  );
}

function SaveSlotForm({ defaultValue, onSave }: SaveSlotFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { pop } = useNavigation();

  return (
    <Form
      isLoading={isLoading}
      navigationTitle="Save Typeless Snapshot"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Snapshot"
            onSubmit={async (values: { slotName: string }) => {
              setIsLoading(true);
              try {
                await onSave(values.slotName);
                pop();
              } finally {
                setIsLoading(false);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="slotName"
        title="Slot Name"
        defaultValue={defaultValue}
        placeholder="work"
      />
      <Form.Description text="Use letters, numbers, dots, underscores, or dashes. The name will be sanitized automatically." />
    </Form>
  );
}

export default function Command() {
  const [model, setModel] = useState<Model>();
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();
  const { push } = useNavigation();

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      await refreshActiveAccountCache();
      const nextModel = await loadModel();
      setModel(nextModel);
      setErrorMessage(undefined);
    } catch (error) {
      setModel(undefined);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const suggestedSlotName = useMemo(() => {
    if (model?.current?.trackedSlot) {
      return model.current.trackedSlot;
    }

    if (model?.current?.email) {
      return sanitizeSlotName(model.current.email.split("@")[0]);
    }

    return "account";
  }, [model?.current?.email, model?.current?.trackedSlot]);

  const handleSave = useCallback(
    async (slotName: string) => {
      await runWithToast("Saving Typeless snapshot", async () => {
        await saveCurrentAccount(slotName);
      });
      await load();
    },
    [load],
  );

  const handleStartAddAccount = useCallback(async () => {
    const confirmed = await confirmAlert({
      title: "Add another Typeless account?",
      message:
        "TLSwitcher will snapshot the current tracked account, move the active Typeless login data into a local pending backup, then open Typeless in a blank login state. After you finish Google login, use Save Current Snapshot to store the new account.",
      primaryAction: {
        title: "Start Login",
        style: Alert.ActionStyle.Default,
      },
    });

    if (!confirmed) {
      return;
    }

    await runWithToast("Preparing Typeless login", async () => {
      await startAddingAccount();
    });
    await load();
  }, [load]);

  const handleSwitch = useCallback(
    async (account: AccountRecord) => {
      if (!account.slotName) {
        return;
      }

      const confirmed = await confirmAlert({
        title: `Switch to ${account.slotName}?`,
        message: `TLSwitcher will snapshot the current tracked account, replace Typeless local data with ${account.slotName}, and reopen ${APP_NAME} if it was running.`,
        primaryAction: {
          title: "Switch Account",
          style: Alert.ActionStyle.Default,
        },
      });

      if (!confirmed) {
        return;
      }

      await runWithToast(`Switching to ${account.slotName}`, async () => {
        await switchAccount(account.slotName as string);
      });
      await load();
    },
    [load],
  );

  const currentAccount = model?.current;
  const savedAccounts = model?.saved ?? [];

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      searchBarPlaceholder="Search slots, email addresses, plans, or usage"
      navigationTitle="TLSwitcher"
    >
      {currentAccount ? (
        <List.Section title="Current Account">
          <List.Item
            id={`current-${currentAccount.key}`}
            title={currentAccount.email}
            subtitle={currentAccount.name || currentAccount.plan}
            icon={{ source: Icon.Person, tintColor: Color.Green }}
            accessories={accountAccessories(currentAccount)}
            detail={
              <List.Item.Detail
                metadata={<AccountMetadata account={currentAccount} />}
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action
                    title="Save Current Snapshot"
                    onAction={() =>
                      push(
                        <SaveSlotForm
                          defaultValue={suggestedSlotName}
                          onSave={handleSave}
                        />,
                      )
                    }
                  />
                  <Action
                    title="Add Another Account"
                    onAction={handleStartAddAccount}
                  />
                  <Action title="Reload" onAction={load} />
                  <Action
                    title="Open Typeless"
                    onAction={async () => {
                      await open("/Applications/Typeless.app");
                    }}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section>
                  <Action.CopyToClipboard
                    title="Copy Email"
                    content={currentAccount.email}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}

      <List.Section title="Saved Accounts">
        {savedAccounts.length > 0 ? (
          savedAccounts.map((account) => (
            <List.Item
              key={account.key}
              id={`saved-${account.key}`}
              title={account.slotName ?? account.email}
              subtitle={account.email}
              icon={Icon.Person}
              accessories={accountAccessories(account)}
              detail={
                <List.Item.Detail
                  metadata={<AccountMetadata account={account} />}
                />
              }
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      title="Switch to This Account"
                      onAction={() => handleSwitch(account)}
                    />
                    <Action
                      title="Save Current Snapshot"
                      onAction={() =>
                        push(
                          <SaveSlotForm
                            defaultValue={suggestedSlotName}
                            onSave={handleSave}
                          />,
                        )
                      }
                    />
                    <Action
                      title="Add Another Account"
                      onAction={handleStartAddAccount}
                    />
                    <Action title="Reload" onAction={load} />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action.CopyToClipboard
                      title="Copy Email"
                      content={account.email}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))
        ) : (
          <List.Item
            id="no-saved-slots"
            title="No saved accounts yet"
            subtitle="Save the current Typeless login as your first slot"
            icon={Icon.Plus}
            actions={
              <ActionPanel>
                <Action
                  title="Save Current Snapshot"
                  onAction={() =>
                    push(
                      <SaveSlotForm
                        defaultValue={suggestedSlotName}
                        onSave={handleSave}
                      />,
                    )
                  }
                />
                {currentAccount ? (
                  <Action
                    title="Add Another Account"
                    onAction={handleStartAddAccount}
                  />
                ) : null}
                <Action title="Reload" onAction={load} />
              </ActionPanel>
            }
          />
        )}
      </List.Section>

      {errorMessage ? (
        <List.Section title="Status">
          <List.Item
            id="status-error"
            title={errorMessage}
            icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
            actions={
              <ActionPanel>
                <Action title="Reload" onAction={load} />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}
    </List>
  );
}
