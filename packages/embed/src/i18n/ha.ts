// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Hausa. Waiting for a native speaker translator: every string is null,
// flagged rather than guessed, with the English above it for reference.
// Until the last one is filled in, a request for this language gets the
// whole widget in English. The footer byline is the brand line and stays
// as it is in every language.

import type { Draft } from './catalogue.js';

export const ha: Draft = {
  // Get set up to be paid
  'widget.label': null,
  // Step {step} of {total}
  'widget.progress': null,
  // Back
  'widget.back': null,
  // Back to {step}
  'widget.back.name': null,
  // Saving your answer
  'widget.busy': null,
  // Getting things ready
  'widget.loading': null,
  // We could not connect. Check your internet connection, then try again.
  'widget.loadFailed': null,
  // Try again
  'widget.retry': null,
  // We could not save that. Try again in a moment.
  'widget.saveFailed': null,
  // This setup link has expired. Ask the people paying you for a new one.
  'widget.expired': null,
  // your name
  'step.name.short': null,
  // how you get paid
  'step.method.short': null,
  // where the money arrives
  'step.destination.short': null,
  // your answers
  'step.review.short': null,
  // What is your full name?
  'name.heading': null,
  // Use the name your bank or wallet has for you. It goes on every receipt.
  'name.hint': null,
  // Full name
  'name.label': null,
  // Save my name
  'name.action': null,
  // Add your full name, so your receipts carry it.
  'name.missing': null,
  // How do you want to be paid?
  'method.heading': null,
  // Pick the one that suits you.
  'method.hint': null,
  // How you get paid
  'method.only.heading': null,
  // One way of being paid is open today. This is it.
  'method.only.hint': null,
  // Use this method
  'method.action': null,
  // Choose how you want to be paid.
  'method.missing': null,
  // USDC to your Stellar wallet
  'method.wallet.name': null,
  // Paid in USDC to a wallet you hold the keys to.
  'method.wallet.line': null,
  // Bank transfer
  'method.bank.name': null,
  // Paid into your own bank account, in your local currency.
  'method.bank.line': null,
  // Mobile money
  'method.mobile.name': null,
  // Paid to your mobile money number, in your local currency.
  'method.mobile.line': null,
  // Cash pickup
  'method.cash.name': null,
  // Collected as cash from an agent near you, in your local currency.
  'method.cash.line': null,
  // Where should the USDC arrive?
  'destination.wallet.heading': null,
  // Your Stellar address
  'destination.wallet.label': null,
  // Copy it from your wallet. It starts with a G and is 56 characters.
  'destination.wallet.hint': null,
  // Save my address
  'destination.wallet.action': null,
  // Paste the address from your wallet.
  'destination.wallet.missing': null,
  // That address is not right. Copy it from your wallet again.
  'destination.wallet.invalid': null,
  // Payouts cannot be sent to this address. Use the address of your own wallet.
  'destination.wallet.unpayable': null,
  // This address cannot receive payouts. Check the address and memo, or use another wallet.
  'destination.refused': null,
  // Memo, only if you were given one
  'destination.memo.label': null,
  // Leave this empty for your own wallet. Some exchanges give a number to add to their address.
  'destination.memo.hint': null,
  // Payouts cannot carry a memo with letters or symbols. Use your own wallet, or an address that needs no memo or only a number.
  'destination.memo.unsupported': null,
  // This address cannot take a separate memo. Leave the memo empty.
  'destination.memo.notNeeded': null,
  // That memo number is too long. Check it and type it again.
  'destination.memo.tooLong': null,
  // Which account should the money reach?
  'destination.bank.heading': null,
  // Your account number
  'destination.bank.label': null,
  // The account number your bank shows on your statement.
  'destination.bank.hint': null,
  // Save my account number
  'destination.bank.action': null,
  // Add the account number the money should reach.
  'destination.bank.missing': null,
  // That account number is not right. Check it on your statement.
  'destination.bank.invalid': null,
  // Which number should the money reach?
  'destination.mobile.heading': null,
  // Your mobile money number
  'destination.mobile.label': null,
  // The number your mobile money account is registered to.
  'destination.mobile.hint': null,
  // Save my number
  'destination.mobile.action': null,
  // Add the number the money should reach.
  'destination.mobile.missing': null,
  // That number is not right. Check it and type it again.
  'destination.mobile.invalid': null,
  // Which number should we text the pickup code to?
  'destination.cash.heading': null,
  // Your phone number
  'destination.cash.label': null,
  // The agent asks for this number when you collect the cash.
  'destination.cash.hint': null,
  // Save my number
  'destination.cash.action': null,
  // Add the number the pickup code should go to.
  'destination.cash.missing': null,
  // That number is not right. Check it and type it again.
  'destination.cash.invalid': null,
  // Does this look right?
  'review.heading': null,
  // We pay to exactly these details.
  'review.hint': null,
  // Name
  'review.name': null,
  // How you get paid
  'review.method': null,
  // Where it arrives
  'review.destination': null,
  // Memo
  'review.memo': null,
  // Change
  'review.change': null,
  // Change {thing}
  'review.change.name': null,
  // Finish setting up
  'review.action': null,
  // Confirm who you are
  'verify.heading': null,
  // Self checks your ID on your phone. We only learn that you passed, never anything from your documents.
  'verify.self.hint': null,
  // Verify with Self
  'verify.self.action': null,
  // The partner that pays you out checks your ID, as the law asks them to. We only learn whether you passed.
  'verify.anchor.hint': null,
  // Continue to the ID check
  'verify.anchor.action': null,
  // Finish the check in the new window
  'verify.waiting.heading': null,
  // When you are done there, come back here. If you closed it by mistake, open it again.
  'verify.waiting.hint': null,
  // Waiting for the result
  'verify.waiting.status': null,
  // I have finished
  'verify.finished': null,
  // Open the check again
  'verify.reopen': null,
  // The result is not in yet. It can take a few minutes.
  'verify.pending': null,
  // Your ID could not be confirmed. Check that it is valid and not expired, then try again.
  'verify.rejected': null,
  // The check closed before it was finished. Start it again.
  'verify.expired': null,
  // Start the check again
  'verify.retry': null,
  // We could not start the check. Try again in a moment.
  'verify.failed': null,
  // Confirm this wallet is yours
  'prove.heading': null,
  // Your wallet signs a short message. It moves no money and costs nothing.
  'prove.hint': null,
  // Sign with my wallet
  'prove.action': null,
  // Waiting for your wallet
  'prove.busy': null,
  // In your wallet, choose to sign a message and paste in the text below. Then paste the signature your wallet shows.
  'prove.manual.hint': null,
  // Message to sign
  'prove.message.label': null,
  // Copy
  'prove.copy': null,
  // Copy the message to sign
  'prove.copy.name': null,
  // Copied
  'prove.copied': null,
  // Signature from your wallet
  'prove.signature.label': null,
  // Paste it exactly as your wallet shows it.
  'prove.signature.hint': null,
  // Paste the signature your wallet gave you.
  'prove.signature.missing': null,
  // Confirm my wallet
  'prove.manual.action': null,
  // Your wallet did not sign. Try again when you are ready.
  'prove.declined': null,
  // That signature does not match this address. Sign the message again with the wallet for this address.
  'prove.invalid': null,
  // The message expired before it was signed. Sign this new one.
  'prove.expired': null,
  // This account is not active yet. A Stellar account is activated with a small amount of XLM, which most wallets add on your first deposit. Activate it in your wallet, add USDC, then try again.
  'receive.accountNotFound': null,
  // Add USDC in your wallet, then try again. Adding USDC needs a small amount of XLM in the account.
  'receive.noTrustline': null,
  // USDC is not enabled for this account yet; ask your wallet provider.
  'receive.notAuthorized': null,
  // Raise the USDC limit in your wallet.
  'receive.limit': null,
  // This key cannot sign for this account any more. Sign with a key that is a current signer of the account.
  'receive.signerNotAuthorized': null,
  // This account is not ready for USDC yet
  'activate.heading': null,
  // We can set it up to receive USDC, at no cost to you. Your wallet signs once to agree, and nothing is taken from it.
  'activate.hint': null,
  // Activate this account for free
  'activate.action': null,
  // Set it up myself
  'activate.self': null,
  // Set up the account myself, in my wallet
  'activate.self.name': null,
  // Activating your account
  'activate.busy': null,
  // The activation did not go through. Try again, or set it up in your wallet.
  'activate.failed': null,
  // You are set up.
  'done.heading': null,
  // Payouts reach you as {method}. Every payout comes with a receipt you can keep.
  'done.body': null,
  'footer.byline': 'Payouts by UJIRA',
};
