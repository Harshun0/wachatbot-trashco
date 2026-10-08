/**
 * Onboarding state machine.
 *
 * States:  ASK_ROLE → ASK_NAME → ASK_CITY → ASK_ALERTS → DONE
 *
 * Rules:
 * - Code drives every transition. LLM only extracts name/city from free text.
 * - Interactive button_reply is the canonical input for role and alert choice.
 * - "restart" or "menu" keywords reopen the flow from ASK_ROLE.
 * - A DONE user who says "hi" / "hello" gets a short registered-user menu.
 * - Unexpected input in any step repeats the current question with a short hint.
 * - Duplicate webhook → same Party state → enqueueReply deduplication → no second send.
 */
import { prisma } from "@/lib/prisma";
import type { Party } from "@prisma/client";
import type { InternalInboundMessage } from "@/providers/types";
import { enqueueReply, buildButtons, buildText } from "./helpers";
import { callLLM } from "./llm";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BotContext {
  orgId: string;
  contact: { id: string; waPhone: string };
  conversation: { id: string; lastInboundAt: Date | null };
  parsed: InternalInboundMessage;
}

// ─── Entry point (called from worker) ────────────────────────────────────────

export async function handleOnboarding(ctx: BotContext): Promise<void> {
  const { orgId, contact, conversation, parsed } = ctx;

  // Upsert Party for this contact
  let party = await prisma.party.findUnique({
    where: { contactId: contact.id },
  });
  if (!party) {
    party = await prisma.party.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        onboardingStep: "ASK_ROLE",
      },
    });
  }

  // Global keyword overrides
  const rawText = extractText(parsed).toLowerCase().trim();
  if (["restart", "menu", "/menu", "/start"].includes(rawText)) {
    await prisma.party.update({
      where: { id: party.id },
      data: { onboardingStep: "ASK_ROLE" },
    });
    await sendAskRole(ctx, party.id);
    return;
  }

  // Route to the current step handler
  switch (party.onboardingStep) {
    case "ASK_ROLE":
      await handleAskRole(ctx, party);
      break;
    case "ASK_NAME":
      await handleAskName(ctx, party);
      break;
    case "ASK_CITY":
      await handleAskCity(ctx, party);
      break;
    case "ASK_ALERTS":
      await handleAskAlerts(ctx, party);
      break;
    case "DONE":
      await handleDone(ctx, party);
      break;
  }
}

// ─── Step: ASK_ROLE ───────────────────────────────────────────────────────────

async function handleAskRole(ctx: BotContext, party: Party): Promise<void> {
  const buttonId = extractButtonId(ctx.parsed);

  if (buttonId === "role_seller" || buttonId === "role_buyer") {
    const role = buttonId === "role_seller" ? "SELLER" : "BUYER";
    await prisma.party.update({
      where: { id: party.id },
      data: { role, onboardingStep: "ASK_NAME" },
    });
    await sendAskName(ctx, party.id);
    return;
  }

  // Not a button reply — could be a text like "seller" or "buyer"
  const text = extractText(ctx.parsed).toLowerCase();
  if (text.includes("seller") || text.includes("sell")) {
    await prisma.party.update({
      where: { id: party.id },
      data: { role: "SELLER", onboardingStep: "ASK_NAME" },
    });
    await sendAskName(ctx, party.id);
    return;
  }
  if (text.includes("buyer") || text.includes("buy") || text.includes("khareed")) {
    await prisma.party.update({
      where: { id: party.id },
      data: { role: "BUYER", onboardingStep: "ASK_NAME" },
    });
    await sendAskName(ctx, party.id);
    return;
  }

  // Unexpected — show the question again (first message → also show it)
  await sendAskRole(ctx, party.id);
}

// ─── Step: ASK_NAME ───────────────────────────────────────────────────────────

async function handleAskName(ctx: BotContext, party: Party): Promise<void> {
  const rawText = extractText(ctx.parsed).trim();
  if (!rawText) {
    await sendAskName(ctx, party.id, true);
    return;
  }

  // Use LLM to extract the name cleanly; fall back to rawText directly
  const extracted = await callLLM<{ name: string }>({
    system:
      "You are a data extractor. The user just provided their name in a WhatsApp message. " +
      "Return JSON with a single field 'name' containing only the person's name, cleaned up. " +
      "No extra text.",
    user: rawText,
    schema: z.object({ name: z.string().min(1) }),
  });

  const name = extracted?.name ?? rawText;

  await prisma.party.update({
    where: { id: party.id },
    data: { name, onboardingStep: "ASK_CITY" },
  });
  await sendAskCity(ctx, party.id);
}

// ─── Step: ASK_CITY ───────────────────────────────────────────────────────────

async function handleAskCity(ctx: BotContext, party: Party): Promise<void> {
  const rawText = extractText(ctx.parsed).trim();
  if (!rawText) {
    await sendAskCity(ctx, party.id, true);
    return;
  }

  const extracted = await callLLM<{ city: string }>({
    system:
      "You are a data extractor. The user just provided their city in a WhatsApp message. " +
      "Return JSON with a single field 'city' containing only the city name, cleaned up. " +
      "No extra text.",
    user: rawText,
    schema: z.object({ city: z.string().min(1) }),
  });

  const city = extracted?.city ?? rawText;

  await prisma.party.update({
    where: { id: party.id },
    data: { city, onboardingStep: "ASK_ALERTS" },
  });
  await sendAskAlerts(ctx, party.id);
}

// ─── Step: ASK_ALERTS ────────────────────────────────────────────────────────

async function handleAskAlerts(ctx: BotContext, party: Party): Promise<void> {
  const buttonId = extractButtonId(ctx.parsed);
  const text = extractText(ctx.parsed).toLowerCase();

  let pref: "ALL" | "MATCHING_ONLY" | "NONE" | null = null;

  if (buttonId === "alert_all" || text.includes("all")) pref = "ALL";
  else if (buttonId === "alert_match" || text.includes("match") || text.includes("matching")) pref = "MATCHING_ONLY";
  else if (buttonId === "alert_none" || text.includes("no alert") || text.includes("nahi")) pref = "NONE";

  if (!pref) {
    await sendAskAlerts(ctx, party.id, true);
    return;
  }

  await prisma.party.update({
    where: { id: party.id },
    data: {
      alertPreference: pref,
      alertsOptedInAt: pref !== "NONE" ? new Date() : null,
      onboardingStep: "DONE",
    },
  });

  // Also update contact optInScope
  await prisma.contact.update({
    where: { id: ctx.contact.id },
    data: { optInScope: pref !== "NONE" ? "service,alerts" : "service" },
  });

  await sendDone(ctx, party);
}

// ─── Step: DONE ───────────────────────────────────────────────────────────────

async function handleDone(ctx: BotContext, party: Party): Promise<void> {
  const text = extractText(ctx.parsed).toLowerCase().trim();
  const greetings = ["hi", "hello", "hey", "hii", "helo", "namaste", "namaskar"];

  if (greetings.some((g) => text.startsWith(g))) {
    await sendRegisteredMenu(ctx, party);
  }
  // Other messages in DONE state are handled by the Phase 2 listing/requirement flow
}

// ─── Message builders ─────────────────────────────────────────────────────────

async function sendAskRole(ctx: BotContext, partyId: string): Promise<void> {
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons(
      "Welcome to the marketplace! 🛒\n\nAre you looking to *sell* products or *buy* them?",
      [
        { id: "role_seller", title: "Seller 🏭" },
        { id: "role_buyer", title: "Buyer 🛍️" },
      ],
      "Type 'restart' anytime to start over"
    ),
    dedupeKey: `onboard_role_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendAskName(ctx: BotContext, partyId: string, hint = false): Promise<void> {
  const body = hint
    ? "Please tell me your name. For example: *Rahul Sharma*"
    : "Great! What's your name? 😊";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(body),
    dedupeKey: `onboard_name_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendAskCity(ctx: BotContext, partyId: string, hint = false): Promise<void> {
  const body = hint
    ? "Please share your city. For example: *Mumbai*"
    : "Which city are you based in? 📍";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(body),
    dedupeKey: `onboard_city_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendAskAlerts(ctx: BotContext, partyId: string, hint = false): Promise<void> {
  const body = hint
    ? "Please choose one of the options below 👇"
    : "Last step! How would you like to receive alerts? 🔔";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons(body, [
      { id: "alert_all", title: "All listings" },
      { id: "alert_match", title: "Only matching" },
      { id: "alert_none", title: "No alerts" },
    ]),
    dedupeKey: `onboard_alerts_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendDone(ctx: BotContext, party: Party): Promise<void> {
  const role = party.role === "SELLER" ? "Seller" : "Buyer";
  const alertMsg =
    party.alertPreference === "ALL"
      ? "You'll get alerts for all new listings."
      : party.alertPreference === "MATCHING_ONLY"
      ? "You'll get alerts only for matching products."
      : "You won't receive alerts (you can change this anytime).";

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      `✅ You're all set, ${party.name ?? "there"}!\n\n` +
        `*Role:* ${role}\n` +
        `*City:* ${party.city ?? "—"}\n` +
        `*Alerts:* ${alertMsg}\n\n` +
        (party.role === "SELLER"
          ? "You can now list a product. Just tell me what you want to sell! 📦"
          : "You can now search for products. Tell me what you need! 🔍")
    ),
    dedupeKey: `onboard_done_${ctx.parsed.providerId}_${party.id}`,
  });
}

async function sendRegisteredMenu(ctx: BotContext, party: Party): Promise<void> {
  const role = party.role === "SELLER" ? "Seller" : "Buyer";
  const action =
    party.role === "SELLER"
      ? "Tell me what you want to list and I'll help you post it."
      : "Tell me what product you're looking for.";

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      `Hi ${party.name ?? "there"}! 👋\n\nYou're registered as a *${role}*.\n\n${action}\n\n_Type 'restart' to redo your profile._`
    ),
    dedupeKey: `menu_${ctx.parsed.providerId}_${party.id}`,
  });
}

// ─── Payload extractors ───────────────────────────────────────────────────────

/**
 * Extract plain text from any inbound message type.
 */
export function extractText(parsed: InternalInboundMessage): string {
  const c = parsed.content as Record<string, unknown> | null;
  if (!c) return "";

  // text message
  if (parsed.contentType === "text") {
    return (c as { body?: string }).body ?? "";
  }

  // interactive button_reply or list_reply
  if (parsed.contentType === "interactive") {
    const interactive = c as {
      type?: string;
      button_reply?: { title?: string };
      list_reply?: { title?: string };
    };
    return (
      interactive.button_reply?.title ??
      interactive.list_reply?.title ??
      ""
    );
  }

  // button (template quick reply)
  if (parsed.contentType === "button") {
    return (c as { text?: string }).text ?? "";
  }

  return "";
}

/**
 * Extract button/list reply id from an interactive message.
 */
export function extractButtonId(parsed: InternalInboundMessage): string | null {
  if (parsed.contentType !== "interactive") return null;
  const c = parsed.content as {
    type?: string;
    button_reply?: { id?: string };
    list_reply?: { id?: string };
  } | null;
  if (!c) return null;
  return c.button_reply?.id ?? c.list_reply?.id ?? null;
}
