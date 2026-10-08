/**
 * Phase 3 — matching engine.
 *
 * Triggered by listings.ts whenever a Listing is published (status -> OPEN)
 * or a Requirement is created/updated. Finds the counterpart OPEN rows that
 * satisfy simple criteria (product, quantity, price, location), records a
 * Match row (idempotent via the listingId+requirementId unique constraint),
 * and notifies both parties — respecting alertPreference, opt-out, the
 * per-day alert cap, and the 24h service window (interactive inside the
 * window, an approved template outside it).
 */
import { prisma } from "@/lib/prisma";
import type { Listing, Requirement, Party, Contact } from "@prisma/client";
import { env } from "@/lib/env";
import { enqueueReply, buildButtons, buildText, isWithin24h } from "./helpers";
import { allowAlert } from "./rate-limit";
import { BTN } from "./onboarding";

// ─── Matching criteria ─────────────────────────────────────────────────────────

function productsMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  return na === nb || na.includes(nb) || nb.includes(na);
}

function locationsMatch(listingLocation: string | null, requirementLocation: string | null): boolean {
  if (!requirementLocation) return true; // buyer didn't specify — any location ok
  if (!listingLocation) return true; // listing has no location yet — don't block on it
  const nl = listingLocation.trim().toLowerCase();
  const nr = requirementLocation.trim().toLowerCase();
  return nl === nr || nl.includes(nr) || nr.includes(nl);
}

export function matchCriteria(listing: Listing, requirement: Requirement): boolean {
  if (!productsMatch(listing.product, requirement.product)) return false;

  if (requirement.quantity != null) {
    if (listing.quantity == null) return false;
    if (Number(listing.quantity) < Number(requirement.quantity)) return false;
  }

  if (requirement.maxPrice != null) {
    if (listing.pricePerUnit == null) return false;
    if (Number(listing.pricePerUnit) > Number(requirement.maxPrice)) return false;
  }

  if (!locationsMatch(listing.location, requirement.location)) return false;

  return true;
}

// ─── Trigger points ────────────────────────────────────────────────────────────

/** Call after a Listing's status becomes OPEN. */
export async function runMatchingForListing(orgId: string, listing: Listing): Promise<void> {
  const requirements = await prisma.requirement.findMany({
    where: { organizationId: orgId, status: "OPEN" },
  });

  for (const requirement of requirements) {
    if (!matchCriteria(listing, requirement)) continue;
    await createMatchAndNotify(orgId, listing, requirement);
  }
}

/** Call after a Requirement is created or updated while still OPEN. */
export async function runMatchingForRequirement(orgId: string, requirement: Requirement): Promise<void> {
  if (requirement.status !== "OPEN") return;

  const listings = await prisma.listing.findMany({
    where: { organizationId: orgId, status: "OPEN" },
  });

  for (const listing of listings) {
    if (!matchCriteria(listing, requirement)) continue;
    await createMatchAndNotify(orgId, listing, requirement);
  }
}

async function createMatchAndNotify(orgId: string, listing: Listing, requirement: Requirement): Promise<void> {
  let match = await prisma.match.findUnique({
    where: { listingId_requirementId: { listingId: listing.id, requirementId: requirement.id } },
  });
  if (!match) {
    match = await prisma.match.create({
      data: { organizationId: orgId, listingId: listing.id, requirementId: requirement.id },
    });
    console.info("[Matching] match created", { listingId: listing.id, requirementId: requirement.id });
  }

  if (!match.notifiedBuyerAt) {
    const sent = await notifyBuyer(orgId, requirement.buyerPartyId, listing, match.id);
    if (sent) {
      await prisma.match.update({ where: { id: match.id }, data: { notifiedBuyerAt: new Date() } });
    }
  }

  if (!match.notifiedSellerAt) {
    const sent = await notifySeller(orgId, listing.sellerPartyId, requirement);
    if (sent) {
      await prisma.match.update({ where: { id: match.id }, data: { notifiedSellerAt: new Date() } });
    }
  }
}

// ─── Notification delivery ─────────────────────────────────────────────────────

interface PartyWithContact extends Party {
  contact: Contact;
}

async function loadPartyWithContact(partyId: string): Promise<PartyWithContact | null> {
  return prisma.party.findUnique({ where: { id: partyId }, include: { contact: true } }) as Promise<PartyWithContact | null>;
}

/**
 * Shared delivery logic: checks alertPreference/opt-out/rate-cap, picks
 * interactive vs template based on the 24h window, and sends.
 * Returns true if a message was actually enqueued.
 */
async function sendAlert(
  orgId: string,
  partyId: string,
  build: {
    interactive: () => ReturnType<typeof buildButtons> | ReturnType<typeof buildText>;
    template: () => { name: string; params: string[] } | null;
    dedupeKey: string;
  }
): Promise<boolean> {
  const party = await loadPartyWithContact(partyId);
  if (!party) return false;
  if (party.alertPreference === "NONE") return false;
  if (party.contact.optedOut) return false;
  if (!(await allowAlert(partyId))) {
    console.info("[Matching] alert cap reached, skipping", { partyId });
    return false;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { organizationId_contactId: { organizationId: orgId, contactId: party.contactId } },
  });

  if (conversation && isWithin24h(conversation.lastInboundAt)) {
    await enqueueReply({
      organizationId: orgId,
      conversationId: conversation.id,
      to: party.contact.waPhone,
      content: build.interactive(),
      dedupeKey: build.dedupeKey,
    });
    return true;
  }

  const tpl = build.template();
  if (!conversation || !tpl) {
    console.warn("[Matching] cannot notify outside window — no conversation or template configured", {
      partyId,
      hasConversation: Boolean(conversation),
      hasTemplate: Boolean(tpl),
    });
    return false;
  }

  await enqueueReply({
    organizationId: orgId,
    conversationId: conversation.id,
    to: party.contact.waPhone,
    content: {
      type: "template",
      name: tpl.name,
      language: { code: env.WA_TEMPLATE_LANGUAGE },
      components: [
        {
          type: "body",
          parameters: tpl.params.map((text) => ({ type: "text", text })),
        },
      ],
    },
    dedupeKey: build.dedupeKey,
  });
  return true;
}

async function notifyBuyer(orgId: string, buyerPartyId: string, listing: Listing, matchId: string): Promise<boolean> {
  return sendAlert(orgId, buyerPartyId, {
    interactive: () =>
      buildButtons(
        `🎯 Naya listing mila jo aapki request se match karta hai!\n*${listing.product}* — ${listing.quantity ?? "?"} ${listing.unit ?? ""}\n💰 ₹${listing.pricePerUnit ?? "?"} per ${listing.unit ?? "unit"}\n📍 ${listing.location ?? "—"}\nCode: *${listing.code}*`,
        [{ id: `${BTN.MATCH_INTERESTED_PREFIX}${matchId}`, title: "Interested" }]
      ),
    template: () =>
      env.WA_TEMPLATE_MATCH_BUYER
        ? { name: env.WA_TEMPLATE_MATCH_BUYER, params: [listing.product, listing.code] }
        : null,
    dedupeKey: `match_buyer_${matchId}`,
  });
}

async function notifySeller(orgId: string, sellerPartyId: string, requirement: Requirement): Promise<boolean> {
  return sendAlert(orgId, sellerPartyId, {
    interactive: () =>
      buildText(
        `🎯 Ek buyer ko *${requirement.product}* chahiye jo aapki listing se match karta hai!\n` +
          `${requirement.quantity ? `Quantity: ${requirement.quantity} ${requirement.unit ?? ""}\n` : ""}` +
          `${requirement.location ? `Location: ${requirement.location}\n` : ""}` +
          "Buyer interested hoga to aapko contact details mil jaayenge."
      ),
    template: () =>
      env.WA_TEMPLATE_MATCH_SELLER
        ? { name: env.WA_TEMPLATE_MATCH_SELLER, params: [requirement.product] }
        : null,
    dedupeKey: `match_seller_${requirement.id}_${sellerPartyId}`,
  });
}

// ─── Buyer "Interested" button ──────────────────────────────────────────────────

/**
 * Called from listings.ts when the buyer taps the "Interested" button.
 * Shares the buyer's contact details with the seller so they can connect
 * directly on WhatsApp, and confirms to the buyer.
 */
export async function handleBuyerInterested(orgId: string, matchId: string, dedupeSeed: string): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      listing: { include: { sellerParty: { include: { contact: true } } } },
      requirement: { include: { buyerParty: { include: { contact: true } } } },
    },
  });
  if (!match) return;

  await prisma.match.update({ where: { id: matchId }, data: { buyerInterestedAt: new Date() } });

  const buyer = match.requirement.buyerParty;
  const seller = match.listing.sellerParty;

  const sellerConversation = await prisma.conversation.findUnique({
    where: { organizationId_contactId: { organizationId: orgId, contactId: seller.contactId } },
  });
  if (sellerConversation) {
    await enqueueReply({
      organizationId: orgId,
      conversationId: sellerConversation.id,
      to: seller.contact.waPhone,
      content: buildText(
        `🙋 *${buyer.name ?? "Ek buyer"}* (${buyer.city ?? "city N/A"}) aapki listing *${match.listing.code}* mein interested hai!\n` +
          `Seedha WhatsApp pe baat karne ke liye: wa.me/${buyer.contact.waPhone.replace("+", "")}`
      ),
      dedupeKey: `match_interested_seller_${dedupeSeed}`,
    });
  }

  const buyerConversation = await prisma.conversation.findUnique({
    where: { organizationId_contactId: { organizationId: orgId, contactId: buyer.contactId } },
  });
  if (buyerConversation) {
    await enqueueReply({
      organizationId: orgId,
      conversationId: buyerConversation.id,
      to: buyer.contact.waPhone,
      content: buildText(`✅ Seller ko bata diya hai, woh jald hi aapse contact karega!`),
      dedupeKey: `match_interested_buyer_${dedupeSeed}`,
    });
  }
}
