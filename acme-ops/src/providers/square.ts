import type { ProviderHttp } from "../kit/http";

export interface SquareMoney {
  amount: number;
  currency: string;
}
export interface SquareLocation {
  id: string;
  name?: string;
  status?: string;
  currency?: string;
}
export interface SquareGiftCard {
  id: string;
  type: string;
  state?: string;
  /** Gift card account number the customer redeems with. */
  gan?: string | null;
  balance_money?: SquareMoney;
}
export interface SquareGiftCardActivity {
  id: string;
  type: string;
  gift_card_id: string;
  gift_card_balance_money?: SquareMoney;
}

/**
 * Square Gift Cards API (https://developer.squareup.com/reference/square/gift-cards-api).
 * ACME issues digital gift cards as a refund method; Square keeps the balance
 * and the customer redeems the GAN at checkout.
 */
export class SquareClient {
  constructor(readonly http: ProviderHttp) {}

  async getLocation(id: string): Promise<SquareLocation> {
    return (await this.http.request<{ location: SquareLocation }>("GET", `/v2/locations/${encodeURIComponent(id)}`)).body.location;
  }

  /** A new digital card. It holds no value until it is activated. */
  async createGiftCard(locationId: string, idempotencyKey: string): Promise<SquareGiftCard> {
    const { body } = await this.http.request<{ gift_card: SquareGiftCard }>("POST", "/v2/gift-cards", {
      json: { idempotency_key: idempotencyKey, location_id: locationId, gift_card: { type: "DIGITAL" } },
    });
    return body.gift_card;
  }

  /** Loads `amount` onto the card. The card was paid for outside Square (a refund), so it names the funding instrument. */
  async activateGiftCard(giftCardId: string, locationId: string, amount: SquareMoney, referenceId: string, idempotencyKey: string): Promise<SquareGiftCardActivity> {
    const { body } = await this.http.request<{ gift_card_activity: SquareGiftCardActivity }>("POST", "/v2/gift-cards/activities", {
      json: {
        idempotency_key: idempotencyKey,
        gift_card_activity: {
          type: "ACTIVATE",
          location_id: locationId,
          gift_card_id: giftCardId,
          activate_activity_details: { amount_money: amount, reference_id: referenceId, buyer_payment_instrument_ids: ["acme-refund"] },
        },
      },
    });
    return body.gift_card_activity;
  }

  async getGiftCard(id: string): Promise<SquareGiftCard> {
    return (await this.http.request<{ gift_card: SquareGiftCard }>("GET", `/v2/gift-cards/${encodeURIComponent(id)}`)).body.gift_card;
  }
}
