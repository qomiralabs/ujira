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
//
// Keys under method.bank, method.mobile, method.cash and their destination
// keys are read by someone paid in their own currency: they never mention
// USDC, a chain or a token. A test holds that line.

export const en = {
  'widget.label': 'Get set up to be paid',
  'widget.progress': 'Step {step} of {total}',
  'widget.back': 'Back',
  'widget.back.name': 'Back to {step}',
  'widget.busy': 'Saving your answer',
  'widget.loading': 'Getting things ready',
  'widget.loadFailed': 'We could not connect. Check your internet connection, then try again.',
  'widget.retry': 'Try again',
  'widget.saveFailed': 'We could not save that. Try again in a moment.',
  'widget.expired': 'This setup link has expired. Ask the people paying you for a new one.',

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
  'destination.wallet.unpayable':
    'Payouts cannot be sent to this address. Use the address of your own wallet.',
  'destination.refused':
    'This address cannot receive payouts. Check the address and memo, or use another wallet.',
  'destination.memo.label': 'Memo, only if you were given one',
  'destination.memo.hint':
    'Leave this empty for your own wallet. Some exchanges give a number to add to their address.',
  'destination.memo.unsupported':
    'Payouts cannot carry a memo with letters or symbols. Use your own wallet, or an address that needs no memo or only a number.',
  'destination.memo.notNeeded': 'This address cannot take a separate memo. Leave the memo empty.',
  'destination.memo.tooLong': 'That memo number is too long. Check it and type it again.',

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
  'review.memo': 'Memo',
  'review.change': 'Change',
  'review.change.name': 'Change {thing}',
  'review.action': 'Finish setting up',

  'prove.heading': 'Confirm this wallet is yours',
  'prove.hint': 'Your wallet signs a short message. It moves no money and costs nothing.',
  'prove.action': 'Sign with my wallet',
  'prove.busy': 'Waiting for your wallet',
  'prove.manual.hint':
    'In your wallet, choose to sign a message and paste in the text below. Then paste the signature your wallet shows.',
  'prove.message.label': 'Message to sign',
  'prove.copy': 'Copy',
  'prove.copy.name': 'Copy the message to sign',
  'prove.copied': 'Copied',
  'prove.signature.label': 'Signature from your wallet',
  'prove.signature.hint': 'Paste it exactly as your wallet shows it.',
  'prove.signature.missing': 'Paste the signature your wallet gave you.',
  'prove.manual.action': 'Confirm my wallet',
  'prove.declined': 'Your wallet did not sign. Try again when you are ready.',
  'prove.invalid':
    'That signature does not match this address. Sign the message again with the wallet for this address.',
  'prove.expired': 'The message expired before it was signed. Sign this new one.',

  'receive.accountNotFound':
    'This account is not active yet. A Stellar account is activated with a small amount of XLM, which most wallets add on your first deposit. Activate it in your wallet, add USDC, then try again.',
  'receive.noTrustline':
    'Add USDC in your wallet, then try again. Adding USDC needs a small amount of XLM in the account.',
  'receive.notAuthorized': 'USDC is not enabled for this account yet; ask your wallet provider.',
  'receive.limit': 'Raise the USDC limit in your wallet.',
  'receive.signerNotAuthorized':
    'This key cannot sign for this account any more. Sign with a key that is a current signer of the account.',

  'activate.heading': 'This account is not ready for USDC yet',
  'activate.hint':
    'We can set it up to receive USDC, at no cost to you. Your wallet signs once to agree, and nothing is taken from it.',
  'activate.action': 'Activate this account for free',
  'activate.self': 'Set it up myself',
  'activate.self.name': 'Set up the account myself, in my wallet',
  'activate.busy': 'Activating your account',
  'activate.failed': 'The activation did not go through. Try again, or set it up in your wallet.',

  'done.heading': 'You are set up.',
  'done.body': 'Payouts reach you as {method}. Every payout comes with a receipt you can keep.',

  'footer.byline': 'Payouts by UJIRA',
} as const;
