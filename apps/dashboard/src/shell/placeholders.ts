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
    body: 'Put money into a mandate and request your first payout. This page then shows what you have paid, what is waiting for someone to say yes, and how long the money will last.',
  },
  payouts: {
    title: 'No payouts yet',
    body: 'Every payout you request, from this dashboard or your own software, appears here with who was paid, how much in their own money, and how far along it is.',
  },
  approvals: {
    title: 'Nothing is waiting for approval',
    body: 'When a payout needs a person to say yes before the money moves, it waits here, oldest first, with the amount, who it is for, and the rule that stopped it.',
  },
  mandates: {
    title: 'No mandates yet',
    body: 'A mandate sets how much can be paid, to whom, and in which countries. Every payout is checked against one before any money moves.',
  },
  recipients: {
    title: 'No recipients yet',
    body: 'People appear here once you request their first payout, with how they like to be paid and everything they have been paid so far.',
  },
  receipts: {
    title: 'No receipts yet',
    body: 'Every payout that arrives gets a receipt: the amount in their own money, the day it landed, and a link to the record on Stellar.',
  },
  funding: {
    title: 'No money added yet',
    body: 'Add USDC to a mandate to pay from it. You will see what each mandate holds, how much of it is already promised, and a warning when one is running low.',
  },
  corridors: {
    title: 'No countries in use yet',
    body: 'Each country you pay into appears here, with how the money gets to people there, how long it usually takes, and how often it arrives first time.',
  },
  developers: {
    title: 'No API keys yet',
    body: 'Create a key so your own software, or an agent, can request payouts and check on them. You see the whole key once, when you create it, so have somewhere safe ready to keep it.',
  },
  settings: {
    title: 'Your team',
    body: 'Invite people, choose what each of them may approve, and decide who hears about it when a payout is stopped.',
  },
};
