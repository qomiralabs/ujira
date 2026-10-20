// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Section } from './nav';

export interface Placeholder {
  title: string;
  body: string;
}

// What each section shows before it has anything in it. Each line says what
// will appear and how it gets there, never a generic "nothing here".
export const PLACEHOLDERS: Record<'overview' | Section, Placeholder> = {
  overview: {
    title: 'Nothing paid from this project yet',
    body: 'Fund a mandate and request your first payout. This page then shows what was paid, what is waiting for approval and how many days each mandate has left.',
  },
  payouts: {
    title: 'No payouts yet',
    body: 'Payouts requested through the API, an agent or this dashboard appear here with the recipient, the amount in their currency and where each one is.',
  },
  approvals: {
    title: 'Nothing is waiting for approval',
    body: 'When a mandate rule holds a payout for a person to sign off, it waits here, oldest first, with the amount, the recipient and the rule that held it.',
  },
  mandates: {
    title: 'No mandates yet',
    body: 'A mandate sets how much can be paid, to whom and in which countries. Every payout is checked against one before any money moves.',
  },
  recipients: {
    title: 'No recipients yet',
    body: 'People appear here after their first payout is requested, with how they like to be paid and everything they have received.',
  },
  receipts: {
    title: 'No receipts yet',
    body: 'Every paid payout gets a receipt with the amount, when it arrived and a link to the transaction on Stellar.',
  },
  funding: {
    title: 'No deposits yet',
    body: 'Deposit USDC to a mandate’s funding address. Balances, committed amounts and low balance alerts show here.',
  },
  corridors: {
    title: 'No corridors used yet',
    body: 'Each country and payout method you pay into shows here with its rail, the median time to paid and the success rate.',
  },
  developers: {
    title: 'No API keys yet',
    body: 'Create a key to request payouts from your code or an agent. Webhooks, their delivery logs and your request logs appear here once requests arrive.',
  },
  settings: {
    title: 'Your team',
    body: 'Invite teammates, set what each person can approve and choose who hears when a payout is blocked.',
  },
};
