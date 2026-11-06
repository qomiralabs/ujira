// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// French. Written to the same house style as en.ts: plain words, the
// recipient addressed as "vous", sentence case. Awaiting native speaker
// review before release.

import type { Draft } from './catalogue.js';

export const fr: Draft = {
  'widget.label': 'Préparez-vous à être payé',
  'widget.progress': 'Étape {step} sur {total}',
  'widget.back': 'Retour',
  'widget.back.name': 'Retour à {step}',
  'widget.busy': 'Enregistrement de votre réponse',
  'widget.loading': 'Préparation en cours',
  'widget.loadFailed': 'Connexion impossible. Vérifiez votre connexion internet, puis réessayez.',
  'widget.retry': 'Réessayer',
  'widget.saveFailed': "Nous n'avons pas pu enregistrer. Réessayez dans un instant.",
  'widget.expired':
    'Ce lien de configuration a expiré. Demandez-en un nouveau aux personnes qui vous paient.',

  'step.name.short': 'votre nom',
  'step.method.short': 'votre moyen de paiement',
  'step.destination.short': "l'endroit où l'argent arrive",
  'step.review.short': 'vos réponses',

  'name.heading': 'Quel est votre nom complet ?',
  'name.hint':
    'Utilisez le nom que votre banque ou votre portefeuille connaît. Il figure sur chaque reçu.',
  'name.label': 'Nom complet',
  'name.action': 'Enregistrer mon nom',
  'name.missing': 'Ajoutez votre nom complet, pour qu’il figure sur vos reçus.',

  'method.heading': 'Comment voulez-vous être payé ?',
  'method.hint': 'Choisissez celui qui vous convient.',
  'method.only.heading': 'Comment vous êtes payé',
  'method.only.hint': "Un seul moyen de paiement est ouvert aujourd'hui. Le voici.",
  'method.action': 'Utiliser ce moyen',
  'method.missing': 'Choisissez comment vous voulez être payé.',

  'method.wallet.name': 'USDC sur votre portefeuille Stellar',
  'method.wallet.line': 'Payé en USDC sur un portefeuille dont vous détenez les clés.',
  'method.bank.name': 'Virement bancaire',
  'method.bank.line': 'Versé sur votre propre compte bancaire, dans votre monnaie locale.',
  'method.mobile.name': 'Mobile money',
  'method.mobile.line': 'Versé sur votre numéro mobile money, dans votre monnaie locale.',
  'method.cash.name': 'Retrait en espèces',
  'method.cash.line':
    'Retiré en espèces auprès d’un agent près de chez vous, dans votre monnaie locale.',

  'destination.wallet.heading': 'Où les USDC doivent-ils arriver ?',
  'destination.wallet.label': 'Votre adresse Stellar',
  'destination.wallet.hint':
    'Copiez-la depuis votre portefeuille. Elle commence par un G et compte 56 caractères.',
  'destination.wallet.action': 'Enregistrer mon adresse',
  'destination.wallet.missing': "Collez l'adresse de votre portefeuille.",
  'destination.wallet.invalid':
    "Cette adresse n'est pas correcte. Copiez-la à nouveau depuis votre portefeuille.",
  'destination.wallet.unpayable':
    "Les paiements ne peuvent pas être envoyés à cette adresse. Utilisez l'adresse de votre propre portefeuille.",
  'destination.refused':
    "Cette adresse ne peut pas recevoir de paiements. Vérifiez l'adresse et le mémo, ou utilisez un autre portefeuille.",
  'destination.memo.label': 'Mémo, seulement si on vous en a donné un',
  'destination.memo.hint':
    'Laissez vide pour votre propre portefeuille. Certaines plateformes d’échange donnent un numéro à ajouter à leur adresse.',
  'destination.memo.unsupported':
    'Les paiements ne peuvent pas porter un mémo avec des lettres ou des symboles. Utilisez votre propre portefeuille, ou une adresse sans mémo ou avec un mémo uniquement en chiffres.',
  'destination.memo.notNeeded':
    'Cette adresse ne peut pas recevoir de mémo séparé. Laissez le mémo vide.',
  'destination.memo.tooLong':
    'Ce numéro de mémo est trop long. Vérifiez-le et saisissez-le à nouveau.',

  'destination.bank.heading': 'Sur quel compte l’argent doit-il arriver ?',
  'destination.bank.label': 'Votre numéro de compte',
  'destination.bank.hint': 'Le numéro de compte indiqué sur votre relevé bancaire.',
  'destination.bank.action': 'Enregistrer mon numéro de compte',
  'destination.bank.missing': 'Ajoutez le numéro du compte qui doit recevoir l’argent.',
  'destination.bank.invalid':
    "Ce numéro de compte n'est pas correct. Vérifiez-le sur votre relevé.",

  'destination.mobile.heading': 'Sur quel numéro l’argent doit-il arriver ?',
  'destination.mobile.label': 'Votre numéro mobile money',
  'destination.mobile.hint': 'Le numéro auquel votre compte mobile money est enregistré.',
  'destination.mobile.action': 'Enregistrer mon numéro',
  'destination.mobile.missing': 'Ajoutez le numéro qui doit recevoir l’argent.',
  'destination.mobile.invalid':
    "Ce numéro n'est pas correct. Vérifiez-le et saisissez-le à nouveau.",

  'destination.cash.heading': 'À quel numéro envoyer le code de retrait par SMS ?',
  'destination.cash.label': 'Votre numéro de téléphone',
  'destination.cash.hint': "L'agent vous demande ce numéro quand vous retirez l'argent.",
  'destination.cash.action': 'Enregistrer mon numéro',
  'destination.cash.missing': 'Ajoutez le numéro qui doit recevoir le code de retrait.',
  'destination.cash.invalid': "Ce numéro n'est pas correct. Vérifiez-le et saisissez-le à nouveau.",

  'review.heading': 'Tout est correct ?',
  'review.hint': 'Nous payons exactement à ces coordonnées.',
  'review.name': 'Nom',
  'review.method': 'Moyen de paiement',
  'review.destination': "Où l'argent arrive",
  'review.memo': 'Mémo',
  'review.change': 'Modifier',
  'review.change.name': 'Modifier {thing}',
  'review.action': 'Terminer la configuration',

  'verify.heading': 'Confirmez votre identité',
  'verify.self.hint':
    "Self vérifie votre pièce d'identité sur votre téléphone. Nous apprenons seulement que la vérification a réussi, jamais le contenu de vos documents.",
  'verify.self.action': 'Vérifier avec Self',
  'verify.anchor.hint':
    "Le partenaire qui vous paie vérifie votre pièce d'identité, comme la loi le lui demande. Nous apprenons seulement si la vérification a réussi.",
  'verify.anchor.action': 'Passer à la vérification',
  'verify.waiting.heading': 'Terminez la vérification dans la nouvelle fenêtre',
  'verify.waiting.hint':
    'Une fois terminé, revenez ici. Si vous l’avez fermée par erreur, ouvrez-la à nouveau.',
  'verify.waiting.status': 'En attente du résultat',
  'verify.finished': "J'ai terminé",
  'verify.reopen': 'Rouvrir la vérification',
  'verify.pending': "Le résultat n'est pas encore arrivé. Cela peut prendre quelques minutes.",
  'verify.rejected':
    "Votre pièce d'identité n'a pas pu être confirmée. Vérifiez qu'elle est valide et non expirée, puis réessayez.",
  'verify.expired': "La vérification s'est fermée avant d'être terminée. Recommencez-la.",
  'verify.retry': 'Recommencer la vérification',
  'verify.failed': "Nous n'avons pas pu lancer la vérification. Réessayez dans un instant.",

  'prove.heading': 'Confirmez que ce portefeuille est le vôtre',
  'prove.hint':
    "Votre portefeuille signe un court message. Cela ne déplace pas d'argent et ne coûte rien.",
  'prove.action': 'Signer avec mon portefeuille',
  'prove.busy': 'En attente de votre portefeuille',
  'prove.manual.hint':
    'Dans votre portefeuille, choisissez de signer un message et collez le texte ci-dessous. Collez ensuite la signature que votre portefeuille affiche.',
  'prove.message.label': 'Message à signer',
  'prove.copy': 'Copier',
  'prove.copy.name': 'Copier le message à signer',
  'prove.copied': 'Copié',
  'prove.signature.label': 'Signature de votre portefeuille',
  'prove.signature.hint': 'Collez-la exactement comme votre portefeuille l’affiche.',
  'prove.signature.missing': 'Collez la signature que votre portefeuille vous a donnée.',
  'prove.manual.action': 'Confirmer mon portefeuille',
  'prove.declined': "Votre portefeuille n'a pas signé. Réessayez quand vous êtes prêt.",
  'prove.invalid':
    'Cette signature ne correspond pas à cette adresse. Signez à nouveau le message avec le portefeuille de cette adresse.',
  'prove.expired': "Le message a expiré avant d'être signé. Signez ce nouveau message.",

  'receive.accountNotFound':
    "Ce compte n'est pas encore actif. Un compte Stellar s'active avec une petite quantité de XLM, que la plupart des portefeuilles ajoutent lors de votre premier dépôt. Activez-le dans votre portefeuille, ajoutez les USDC, puis réessayez.",
  'receive.noTrustline':
    "Ajoutez les USDC dans votre portefeuille, puis réessayez. L'ajout des USDC demande une petite quantité de XLM sur le compte.",
  'receive.notAuthorized':
    'Les USDC ne sont pas encore activés pour ce compte ; renseignez-vous auprès du fournisseur de votre portefeuille.',
  'receive.limit': 'Augmentez la limite USDC dans votre portefeuille.',
  'receive.signerNotAuthorized':
    'Cette clé ne peut plus signer pour ce compte. Signez avec une clé qui est actuellement signataire du compte.',

  'activate.heading': "Ce compte n'est pas encore prêt pour les USDC",
  'activate.hint':
    'Nous pouvons le configurer pour recevoir des USDC, sans frais pour vous. Votre portefeuille signe une fois pour donner son accord, et rien ne lui est prélevé.',
  'activate.action': 'Activer ce compte gratuitement',
  'activate.self': 'Le configurer moi-même',
  'activate.self.name': 'Configurer le compte moi-même, dans mon portefeuille',
  'activate.busy': 'Activation de votre compte',
  'activate.failed':
    "L'activation n'a pas abouti. Réessayez, ou configurez le compte dans votre portefeuille.",

  'done.heading': 'Tout est prêt.',
  'done.body':
    'Les paiements vous parviennent en {method}. Chaque paiement est accompagné d’un reçu que vous pouvez conserver.',

  'footer.byline': 'Payouts by UJIRA',
};
