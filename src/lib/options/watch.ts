import { px } from "../format.js";
import type { Setup } from "../types.js";
import { formatExpiryLabel } from "./expiry.js";
import { indexPointsToPremium } from "./pricing.js";
import type { OptionPending, OptionPosition } from "./types.js";

export interface OptionWatchRead {
  tone: "open" | "working" | "wait";
  label: string;
  reason: string;
}

export function describeOptionWatch(input: {
  auto: boolean;
  position: OptionPosition | null;
  pending: OptionPending | null;
  setup: Setup;
  markPremium: number | null;
  spot: number | null;
}): OptionWatchRead {
  const { auto, position, pending, setup, markPremium, spot } = input;

  if (position) {
    const markText = markPremium == null ? "" : ` Mark premium ${px(markPremium)}.`;
    const need = markPremium == null
      ? null
      : indexPointsToPremium({
        markPremium,
        targetPremium: position.premiumTarget,
        delta: position.deltaAtEntry,
      });
    let deltaNote = "";
    if (need != null && spot != null) {
      if (Math.abs(need) < 0.5) {
        deltaNote = " Option premium is near the target.";
      } else if (position.right === "CE") {
        deltaNote = need > 0
          ? ` About ${px(need)} index points still needed (via delta) for the target premium.`
          : " Underlying move has already covered the target on a delta basis.";
      } else {
        deltaNote = need > 0
          ? ` About ${px(need)} index points still needed lower (via delta) for the target premium.`
          : " Underlying move has already covered the target on a delta basis.";
      }
    } else if (spot != null && markPremium != null && Math.abs(spot - position.indexEntry) < 5) {
      deltaNote = " Underlying is sideways — modeled premium decays with theta while the index sits still.";
    }
    return {
      tone: "open",
      label: "OPEN",
      reason: `Long ${position.right} ${px(position.strike)} (${formatExpiryLabel(position.expiry)}) from premium ${px(position.premiumEntry)}.${markText} Stop ${px(position.premiumStop)}, target ${px(position.premiumTarget)}.${deltaNote} A new option order waits until this one closes.`,
    };
  }

  if (!auto) {
    return {
      tone: "wait",
      label: "AUTO OFF",
      reason: "Auto is off, so no new option buy will be armed. An open long option still exits on stop, target, flatten, or expiry square-off.",
    };
  }

  if (pending) {
    const touch = pending.direction === "long"
      ? `Waiting for a later candle to trade up through index ${px(pending.indexEntry)} to buy the ${pending.right}.`
      : `Waiting for a later candle to trade down through index ${px(pending.indexEntry)} to buy the ${pending.right}.`;
    let away = "";
    if (markPremium != null) {
      const gap = pending.premiumEntry - markPremium;
      away = gap > 0.05
        ? ` Last option mark ${px(markPremium)} is still ${px(Math.abs(gap))} under the armed entry premium ${px(pending.premiumEntry)}.`
        : gap < -0.05
          ? ` Last option mark ${px(markPremium)} is above the armed entry premium ${px(pending.premiumEntry)}; fill still needs the index to trade through entry on a later candle.`
          : ` Last option mark ${px(markPremium)} is at the entry premium. The buy prints on a candle after the signal.`;
    }
    if (spot != null) {
      const indexGap = pending.direction === "long" ? pending.indexEntry - spot : spot - pending.indexEntry;
      if (indexGap > 0) {
        away += ` Index last ${px(spot)} is still ${px(indexGap)} away.`;
      }
    }
    return {
      tone: "working",
      label: "WAITING",
      reason: `Buy ${pending.right} ${px(pending.strike)} (${formatExpiryLabel(pending.expiry)}, ${pending.expiryKind}) armed at premium ${px(pending.premiumEntry)}. ${touch}${away} Stop ${px(pending.premiumStop)}, target ${px(pending.premiumTarget)}.`,
    };
  }

  return {
    tone: "wait",
    label: setup.status === "stand-aside" ? "STAND ASIDE" : "NO ORDER",
    reason: setup.summary || "Waiting for a closed signal candle from the index scalp above.",
  };
}
