// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Portuguese, written to read naturally in Brazil, Mozambique and Angola:
// the recipient addressed as "você", no regional slang. Same house style as
// en.ts. Awaiting native speaker review before release, which should settle
// the European and African spellings.

import type { Draft } from './catalogue.js';

export const pt: Draft = {
  'widget.label': 'Prepare-se para receber pagamentos',
  'widget.progress': 'Passo {step} de {total}',
  'widget.back': 'Voltar',
  'widget.back.name': 'Voltar para {step}',
  'widget.busy': 'Salvando sua resposta',
  'widget.loading': 'Preparando tudo',
  'widget.loadFailed':
    'Não conseguimos conectar. Verifique sua conexão com a internet e tente de novo.',
  'widget.retry': 'Tentar de novo',
  'widget.saveFailed': 'Não conseguimos salvar. Tente de novo em instantes.',
  'widget.expired': 'Este link de configuração expirou. Peça um novo a quem paga você.',

  'step.name.short': 'seu nome',
  'step.method.short': 'como você recebe',
  'step.destination.short': 'onde o dinheiro chega',
  'step.review.short': 'suas respostas',

  'name.heading': 'Qual é o seu nome completo?',
  'name.hint': 'Use o nome que o seu banco ou a sua carteira tem. Ele aparece em cada recibo.',
  'name.label': 'Nome completo',
  'name.action': 'Salvar meu nome',
  'name.missing': 'Adicione seu nome completo, para que ele apareça nos seus recibos.',

  'method.heading': 'Como você quer receber?',
  'method.hint': 'Escolha a opção que for melhor para você.',
  'method.only.heading': 'Como você recebe',
  'method.only.hint': 'Hoje há uma única forma de receber. É esta.',
  'method.action': 'Usar esta forma',
  'method.missing': 'Escolha como você quer receber.',

  'method.wallet.name': 'USDC na sua carteira Stellar',
  'method.wallet.line': 'Pago em USDC numa carteira cujas chaves são suas.',
  'method.bank.name': 'Transferência bancária',
  'method.bank.line': 'Pago na sua própria conta bancária, na sua moeda local.',
  'method.mobile.name': 'Dinheiro móvel',
  'method.mobile.line': 'Pago no seu número de dinheiro móvel, na sua moeda local.',
  'method.cash.name': 'Retirada em dinheiro',
  'method.cash.line': 'Recebido em dinheiro com um agente perto de você, na sua moeda local.',

  'destination.wallet.heading': 'Onde os USDC devem chegar?',
  'destination.wallet.label': 'Seu endereço Stellar',
  'destination.wallet.hint': 'Copie da sua carteira. Ele começa com G e tem 56 caracteres.',
  'destination.wallet.action': 'Salvar meu endereço',
  'destination.wallet.missing': 'Cole o endereço da sua carteira.',
  'destination.wallet.invalid': 'Esse endereço não está certo. Copie de novo da sua carteira.',
  'destination.wallet.unpayable':
    'Não é possível enviar pagamentos para este endereço. Use o endereço da sua própria carteira.',
  'destination.refused':
    'Este endereço não pode receber pagamentos. Confira o endereço e o memo, ou use outra carteira.',
  'destination.memo.label': 'Memo, só se você recebeu um',
  'destination.memo.hint':
    'Deixe em branco para a sua própria carteira. Algumas corretoras dão um número para acrescentar ao endereço.',
  'destination.memo.unsupported':
    'Os pagamentos não podem levar um memo com letras ou símbolos. Use sua própria carteira, ou um endereço que não precise de memo ou só de um número.',
  'destination.memo.notNeeded': 'Este endereço não aceita um memo à parte. Deixe o memo em branco.',
  'destination.memo.tooLong': 'Esse número de memo é longo demais. Confira e digite de novo.',

  'destination.bank.heading': 'Em qual conta o dinheiro deve chegar?',
  'destination.bank.label': 'Seu número de conta',
  'destination.bank.hint': 'O número de conta que aparece no seu extrato bancário.',
  'destination.bank.action': 'Salvar meu número de conta',
  'destination.bank.missing': 'Adicione o número da conta onde o dinheiro deve chegar.',
  'destination.bank.invalid': 'Esse número de conta não está certo. Confira no seu extrato.',

  'destination.mobile.heading': 'Em qual número o dinheiro deve chegar?',
  'destination.mobile.label': 'Seu número de dinheiro móvel',
  'destination.mobile.hint': 'O número em que sua conta de dinheiro móvel está registrada.',
  'destination.mobile.action': 'Salvar meu número',
  'destination.mobile.missing': 'Adicione o número onde o dinheiro deve chegar.',
  'destination.mobile.invalid': 'Esse número não está certo. Confira e digite de novo.',

  'destination.cash.heading': 'Para qual número enviamos o código de retirada por SMS?',
  'destination.cash.label': 'Seu número de telefone',
  'destination.cash.hint': 'O agente pede este número quando você recebe o dinheiro.',
  'destination.cash.action': 'Salvar meu número',
  'destination.cash.missing': 'Adicione o número que deve receber o código de retirada.',
  'destination.cash.invalid': 'Esse número não está certo. Confira e digite de novo.',

  'review.heading': 'Está tudo certo?',
  'review.hint': 'Pagamos exatamente para estes dados.',
  'review.name': 'Nome',
  'review.method': 'Como você recebe',
  'review.destination': 'Onde chega',
  'review.memo': 'Memo',
  'review.change': 'Alterar',
  'review.change.name': 'Alterar {thing}',
  'review.action': 'Concluir a configuração',

  'verify.heading': 'Confirme quem você é',
  'verify.self.hint':
    'A Self verifica seu documento de identidade no seu telefone. Só ficamos sabendo que a verificação deu certo, nunca nada dos seus documentos.',
  'verify.self.action': 'Verificar com a Self',
  'verify.anchor.hint':
    'O parceiro que paga você verifica seu documento de identidade, como a lei exige. Só ficamos sabendo se a verificação deu certo.',
  'verify.anchor.action': 'Ir para a verificação',
  'verify.waiting.heading': 'Termine a verificação na nova janela',
  'verify.waiting.hint':
    'Quando terminar lá, volte aqui. Se você fechou a janela sem querer, abra de novo.',
  'verify.waiting.status': 'Aguardando o resultado',
  'verify.finished': 'Terminei',
  'verify.reopen': 'Abrir a verificação de novo',
  'verify.pending': 'O resultado ainda não chegou. Pode levar alguns minutos.',
  'verify.rejected':
    'Não foi possível confirmar seu documento. Confira se ele é válido e não está vencido, e tente de novo.',
  'verify.expired': 'A verificação foi encerrada antes de terminar. Comece de novo.',
  'verify.retry': 'Começar a verificação de novo',
  'verify.failed': 'Não conseguimos iniciar a verificação. Tente de novo em instantes.',

  'prove.heading': 'Confirme que esta carteira é sua',
  'prove.hint': 'Sua carteira assina uma mensagem curta. Isso não move dinheiro e não custa nada.',
  'prove.action': 'Assinar com minha carteira',
  'prove.busy': 'Aguardando sua carteira',
  'prove.manual.hint':
    'Na sua carteira, escolha assinar uma mensagem e cole o texto abaixo. Depois cole a assinatura que a carteira mostrar.',
  'prove.message.label': 'Mensagem para assinar',
  'prove.copy': 'Copiar',
  'prove.copy.name': 'Copiar a mensagem para assinar',
  'prove.copied': 'Copiado',
  'prove.signature.label': 'Assinatura da sua carteira',
  'prove.signature.hint': 'Cole exatamente como a sua carteira mostra.',
  'prove.signature.missing': 'Cole a assinatura que sua carteira deu.',
  'prove.manual.action': 'Confirmar minha carteira',
  'prove.declined': 'Sua carteira não assinou. Tente de novo quando estiver pronto.',
  'prove.invalid':
    'Essa assinatura não corresponde a este endereço. Assine a mensagem de novo com a carteira deste endereço.',
  'prove.expired': 'A mensagem expirou antes de ser assinada. Assine esta nova.',

  'receive.accountNotFound':
    'Esta conta ainda não está ativa. Uma conta Stellar é ativada com uma pequena quantidade de XLM, que a maioria das carteiras adiciona no seu primeiro depósito. Ative a conta na sua carteira, adicione USDC e tente de novo.',
  'receive.noTrustline':
    'Adicione USDC na sua carteira e tente de novo. Adicionar USDC exige uma pequena quantidade de XLM na conta.',
  'receive.notAuthorized':
    'O USDC ainda não está habilitado para esta conta; fale com o fornecedor da sua carteira.',
  'receive.limit': 'Aumente o limite de USDC na sua carteira.',
  'receive.signerNotAuthorized':
    'Esta chave não pode mais assinar por esta conta. Assine com uma chave que seja signatária atual da conta.',

  'activate.heading': 'Esta conta ainda não está pronta para USDC',
  'activate.hint':
    'Podemos prepará-la para receber USDC, sem custo para você. Sua carteira assina uma vez para concordar, e nada é tirado dela.',
  'activate.action': 'Ativar esta conta grátis',
  'activate.self': 'Eu mesmo preparo',
  'activate.self.name': 'Preparar a conta eu mesmo, na minha carteira',
  'activate.busy': 'Ativando sua conta',
  'activate.failed': 'A ativação não deu certo. Tente de novo, ou prepare a conta na sua carteira.',

  'done.heading': 'Está tudo pronto.',
  'done.body':
    'Os pagamentos chegam a você como {method}. Cada pagamento vem com um recibo para guardar.',

  'footer.byline': 'Payouts by UJIRA',
};
