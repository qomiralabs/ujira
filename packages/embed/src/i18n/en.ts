// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// English copy for the onboarding widget. Every string a person reads lives
// here, and the catalogue is the only place any of them appear. Other
// languages are added as a file next to this one and registered in
// catalogue.ts; each one needs native speaker review before it ships.
//
// House style: sentence case, plain words, no filler. A label says what the
// control does. Where a person chooses between things we named, every choice
// carries one short line saying what it is.

export const en = {
  'widget.label': 'Get set up to be paid',
  'widget.progress': 'Step {step} of {total}',
  'widget.back': 'Back',
  'widget.back.name': 'Back to {step}',
  'widget.busy': 'Saving your answer',

  'step.name.short': 'your name',
  'step.method.short': 'how you get paid',
  'step.destination.short': 'where the money arrives',
  'step.review.short': 'your answers',

  'name.heading': 'What is your full name?',
  'name.hint': 'Use the name your bank or wallet has for you. It goes on every receipt.',
  'name.label': 'Full name',
  'name.action': 'Save my name',
  'name.missing': 'Add your full name, so your receipts carry it.',

  'method.heading': 'How do you want to be paid?',
  'method.hint': 'Pick the one that suits you.',
  'method.only.heading': 'How you get paid',
  'method.only.hint': 'One way of being paid is open today. This is it.',
  'method.action': 'Use this method',
  'method.missing': 'Choose how you want to be paid.',

  'method.wallet.name': 'USDC to your Stellar wallet',
  'method.wallet.line': 'Paid in USDC to a wallet you hold the keys to.',
  'method.bank.name': 'Bank transfer',
  'method.bank.line': 'Paid into your own bank account, in your local currency.',
  'method.mobile.name': 'Mobile money',
  'method.mobile.line': 'Paid to your mobile money number, in your local currency.',
  'method.cash.name': 'Cash pickup',
  'method.cash.line': 'Collected as cash from an agent near you, in your local currency.',

  'destination.wallet.heading': 'Where should the USDC arrive?',
  'destination.wallet.label': 'Your Stellar address',
  'destination.wallet.hint': 'Copy it from your wallet. It starts with a G and is 56 characters.',
  'destination.wallet.action': 'Save my address',
  'destination.wallet.missing': 'Paste the address from your wallet.',
  'destination.wallet.invalid': 'That address is not right. Copy it from your wallet again.',

  'destination.bank.heading': 'Which account should the money reach?',
  'destination.bank.label': 'Your account number',
  'destination.bank.hint': 'The account number your bank shows on your statement.',
  'destination.bank.action': 'Save my account number',
  'destination.bank.missing': 'Add the account number the money should reach.',
  'destination.bank.invalid': 'That account number is not right. Check it on your statement.',

  'destination.mobile.heading': 'Which number should the money reach?',
  'destination.mobile.label': 'Your mobile money number',
  'destination.mobile.hint': 'The number your mobile money account is registered to.',
  'destination.mobile.action': 'Save my number',
  'destination.mobile.missing': 'Add the number the money should reach.',
  'destination.mobile.invalid': 'That number is not right. Check it and type it again.',

  'destination.cash.heading': 'Which number should we text the pickup code to?',
  'destination.cash.label': 'Your phone number',
  'destination.cash.hint': 'The agent asks for this number when you collect the cash.',
  'destination.cash.action': 'Save my number',
  'destination.cash.missing': 'Add the number the pickup code should go to.',
  'destination.cash.invalid': 'That number is not right. Check it and type it again.',

  'review.heading': 'Does this look right?',
  'review.hint': 'We pay to exactly these details.',
  'review.name': 'Name',
  'review.method': 'How you get paid',
  'review.destination': 'Where it arrives',
  'review.change': 'Change',
  'review.change.name': 'Change {thing}',
  'review.action': 'Finish setting up',

  'done.heading': 'You are set up.',
  'done.body': 'Payouts reach you as {method}. Every payout comes with a receipt you can keep.',

  'footer.byline': 'Payouts by UJIRA',
} as const;
