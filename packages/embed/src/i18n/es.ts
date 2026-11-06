// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Spanish, neutral rather than regional, the recipient addressed as "tú".
// Written to the same house style as en.ts. Awaiting native speaker review
// before release.

import type { Draft } from './catalogue.js';

export const es: Draft = {
  'widget.label': 'Prepárate para recibir pagos',
  'widget.progress': 'Paso {step} de {total}',
  'widget.back': 'Atrás',
  'widget.back.name': 'Volver a {step}',
  'widget.busy': 'Guardando tu respuesta',
  'widget.loading': 'Preparando todo',
  'widget.loadFailed': 'No pudimos conectar. Revisa tu conexión a internet y vuelve a intentarlo.',
  'widget.retry': 'Intentar de nuevo',
  'widget.saveFailed': 'No pudimos guardarlo. Vuelve a intentarlo en un momento.',
  'widget.expired': 'Este enlace de configuración ha caducado. Pide uno nuevo a quienes te pagan.',

  'step.name.short': 'tu nombre',
  'step.method.short': 'cómo te pagan',
  'step.destination.short': 'dónde llega el dinero',
  'step.review.short': 'tus respuestas',

  'name.heading': '¿Cuál es tu nombre completo?',
  'name.hint': 'Usa el nombre que tiene tu banco o tu billetera. Aparece en cada recibo.',
  'name.label': 'Nombre completo',
  'name.action': 'Guardar mi nombre',
  'name.missing': 'Añade tu nombre completo para que aparezca en tus recibos.',

  'method.heading': '¿Cómo quieres que te paguen?',
  'method.hint': 'Elige la opción que mejor te venga.',
  'method.only.heading': 'Cómo te pagan',
  'method.only.hint': 'Hoy hay una sola forma de pago disponible. Es esta.',
  'method.action': 'Usar esta forma de pago',
  'method.missing': 'Elige cómo quieres que te paguen.',

  'method.wallet.name': 'USDC en tu billetera Stellar',
  'method.wallet.line': 'Pagado en USDC a una billetera cuyas claves tienes tú.',
  'method.bank.name': 'Transferencia bancaria',
  'method.bank.line': 'Pagado en tu propia cuenta bancaria, en tu moneda local.',
  'method.mobile.name': 'Dinero móvil',
  'method.mobile.line': 'Pagado a tu número de dinero móvil, en tu moneda local.',
  'method.cash.name': 'Retiro en efectivo',
  'method.cash.line': 'Lo retiras en efectivo con un agente cerca de ti, en tu moneda local.',

  'destination.wallet.heading': '¿Dónde deben llegar los USDC?',
  'destination.wallet.label': 'Tu dirección Stellar',
  'destination.wallet.hint': 'Cópiala de tu billetera. Empieza por G y tiene 56 caracteres.',
  'destination.wallet.action': 'Guardar mi dirección',
  'destination.wallet.missing': 'Pega la dirección de tu billetera.',
  'destination.wallet.invalid': 'Esa dirección no es correcta. Cópiala de nuevo de tu billetera.',
  'destination.wallet.unpayable':
    'No se pueden enviar pagos a esta dirección. Usa la dirección de tu propia billetera.',
  'destination.refused':
    'Esta dirección no puede recibir pagos. Revisa la dirección y el memo, o usa otra billetera.',
  'destination.memo.label': 'Memo, solo si te dieron uno',
  'destination.memo.hint':
    'Déjalo vacío para tu propia billetera. Algunos exchanges dan un número para añadir a su dirección.',
  'destination.memo.unsupported':
    'Los pagos no pueden llevar un memo con letras o símbolos. Usa tu propia billetera, o una dirección que no necesite memo o solo uno numérico.',
  'destination.memo.notNeeded': 'Esta dirección no admite un memo aparte. Deja el memo vacío.',
  'destination.memo.tooLong':
    'Ese número de memo es demasiado largo. Revísalo y escríbelo de nuevo.',

  'destination.bank.heading': '¿A qué cuenta debe llegar el dinero?',
  'destination.bank.label': 'Tu número de cuenta',
  'destination.bank.hint': 'El número de cuenta que aparece en tu extracto bancario.',
  'destination.bank.action': 'Guardar mi número de cuenta',
  'destination.bank.missing': 'Añade el número de la cuenta a la que debe llegar el dinero.',
  'destination.bank.invalid': 'Ese número de cuenta no es correcto. Revísalo en tu extracto.',

  'destination.mobile.heading': '¿A qué número debe llegar el dinero?',
  'destination.mobile.label': 'Tu número de dinero móvil',
  'destination.mobile.hint': 'El número con el que está registrada tu cuenta de dinero móvil.',
  'destination.mobile.action': 'Guardar mi número',
  'destination.mobile.missing': 'Añade el número al que debe llegar el dinero.',
  'destination.mobile.invalid': 'Ese número no es correcto. Revísalo y escríbelo de nuevo.',

  'destination.cash.heading': '¿A qué número te enviamos el código de retiro?',
  'destination.cash.label': 'Tu número de teléfono',
  'destination.cash.hint': 'El agente te pide este número cuando retiras el efectivo.',
  'destination.cash.action': 'Guardar mi número',
  'destination.cash.missing': 'Añade el número al que debe ir el código de retiro.',
  'destination.cash.invalid': 'Ese número no es correcto. Revísalo y escríbelo de nuevo.',

  'review.heading': '¿Está todo bien?',
  'review.hint': 'Pagamos exactamente a estos datos.',
  'review.name': 'Nombre',
  'review.method': 'Cómo te pagan',
  'review.destination': 'Dónde llega',
  'review.memo': 'Memo',
  'review.change': 'Cambiar',
  'review.change.name': 'Cambiar {thing}',
  'review.action': 'Terminar la configuración',

  'verify.heading': 'Confirma quién eres',
  'verify.self.hint':
    'Self comprueba tu documento de identidad en tu teléfono. Solo sabemos que la comprobación salió bien, nunca nada de tus documentos.',
  'verify.self.action': 'Verificar con Self',
  'verify.anchor.hint':
    'El socio que te paga comprueba tu documento de identidad, como le exige la ley. Solo sabemos si la comprobación salió bien.',
  'verify.anchor.action': 'Ir a la comprobación',
  'verify.waiting.heading': 'Termina la comprobación en la ventana nueva',
  'verify.waiting.hint':
    'Cuando termines allí, vuelve aquí. Si la cerraste sin querer, ábrela de nuevo.',
  'verify.waiting.status': 'Esperando el resultado',
  'verify.finished': 'Ya terminé',
  'verify.reopen': 'Abrir la comprobación de nuevo',
  'verify.pending': 'El resultado aún no ha llegado. Puede tardar unos minutos.',
  'verify.rejected':
    'No se pudo confirmar tu documento. Comprueba que es válido y no ha caducado, y vuelve a intentarlo.',
  'verify.expired': 'La comprobación se cerró antes de terminar. Empiézala de nuevo.',
  'verify.retry': 'Empezar la comprobación de nuevo',
  'verify.failed': 'No pudimos iniciar la comprobación. Vuelve a intentarlo en un momento.',

  'prove.heading': 'Confirma que esta billetera es tuya',
  'prove.hint': 'Tu billetera firma un mensaje corto. No mueve dinero y no cuesta nada.',
  'prove.action': 'Firmar con mi billetera',
  'prove.busy': 'Esperando a tu billetera',
  'prove.manual.hint':
    'En tu billetera, elige firmar un mensaje y pega el texto de abajo. Luego pega la firma que muestra tu billetera.',
  'prove.message.label': 'Mensaje para firmar',
  'prove.copy': 'Copiar',
  'prove.copy.name': 'Copiar el mensaje para firmar',
  'prove.copied': 'Copiado',
  'prove.signature.label': 'Firma de tu billetera',
  'prove.signature.hint': 'Pégala tal como la muestra tu billetera.',
  'prove.signature.missing': 'Pega la firma que te dio tu billetera.',
  'prove.manual.action': 'Confirmar mi billetera',
  'prove.declined': 'Tu billetera no firmó. Inténtalo de nuevo cuando quieras.',
  'prove.invalid':
    'Esa firma no corresponde a esta dirección. Firma el mensaje de nuevo con la billetera de esta dirección.',
  'prove.expired': 'El mensaje caducó antes de firmarse. Firma este nuevo.',

  'receive.accountNotFound':
    'Esta cuenta aún no está activa. Una cuenta Stellar se activa con una pequeña cantidad de XLM, que la mayoría de las billeteras añade con tu primer depósito. Actívala en tu billetera, añade USDC y vuelve a intentarlo.',
  'receive.noTrustline':
    'Añade USDC en tu billetera y vuelve a intentarlo. Añadir USDC requiere una pequeña cantidad de XLM en la cuenta.',
  'receive.notAuthorized':
    'USDC aún no está habilitado para esta cuenta; consulta a tu proveedor de billetera.',
  'receive.limit': 'Sube el límite de USDC en tu billetera.',
  'receive.signerNotAuthorized':
    'Esta clave ya no puede firmar por esta cuenta. Firma con una clave que sea firmante actual de la cuenta.',

  'activate.heading': 'Esta cuenta aún no está lista para USDC',
  'activate.hint':
    'Podemos prepararla para recibir USDC, sin costo para ti. Tu billetera firma una vez para aceptar, y no se le cobra nada.',
  'activate.action': 'Activar esta cuenta gratis',
  'activate.self': 'Prepararla yo mismo',
  'activate.self.name': 'Preparar la cuenta yo mismo, en mi billetera',
  'activate.busy': 'Activando tu cuenta',
  'activate.failed':
    'La activación no se completó. Inténtalo de nuevo, o prepárala en tu billetera.',

  'done.heading': 'Ya está todo listo.',
  'done.body': 'Los pagos te llegan como {method}. Cada pago incluye un recibo que puedes guardar.',

  'footer.byline': 'Payouts by UJIRA',
};
