// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Swahili, standard East African usage, the recipient addressed directly.
// Same house style as en.ts. Awaiting native speaker review before release.

import type { Draft } from './catalogue.js';

export const sw: Draft = {
  'widget.label': 'Jiandae kulipwa',
  'widget.progress': 'Hatua {step} kati ya {total}',
  'widget.back': 'Rudi',
  'widget.back.name': 'Rudi kwenye {step}',
  'widget.busy': 'Tunahifadhi jibu lako',
  'widget.loading': 'Tunaandaa kila kitu',
  'widget.loadFailed':
    'Hatukuweza kuunganisha. Angalia muunganisho wako wa intaneti, kisha ujaribu tena.',
  'widget.retry': 'Jaribu tena',
  'widget.saveFailed': 'Hatukuweza kuhifadhi hilo. Jaribu tena baada ya muda mfupi.',
  'widget.expired':
    'Kiungo hiki cha usajili kimeisha muda wake. Omba kipya kutoka kwa wanaokulipa.',

  'step.name.short': 'jina lako',
  'step.method.short': 'jinsi unavyolipwa',
  'step.destination.short': 'pesa zinapofika',
  'step.review.short': 'majibu yako',

  'name.heading': 'Jina lako kamili ni nani?',
  'name.hint': 'Tumia jina ambalo benki au pochi yako inalitambua. Linaonekana kwenye kila risiti.',
  'name.label': 'Jina kamili',
  'name.action': 'Hifadhi jina langu',
  'name.missing': 'Weka jina lako kamili, ili lionekane kwenye risiti zako.',

  'method.heading': 'Ungependa kulipwa vipi?',
  'method.hint': 'Chagua inayokufaa.',
  'method.only.heading': 'Jinsi unavyolipwa',
  'method.only.hint': 'Njia moja ya kulipwa iko wazi leo. Ni hii.',
  'method.action': 'Tumia njia hii',
  'method.missing': 'Chagua jinsi ungependa kulipwa.',

  'method.wallet.name': 'USDC kwenye pochi yako ya Stellar',
  'method.wallet.line': 'Unalipwa kwa USDC kwenye pochi ambayo funguo zake ni zako.',
  'method.bank.name': 'Uhamisho wa benki',
  'method.bank.line': 'Unalipwa kwenye akaunti yako ya benki, kwa sarafu ya nchi yako.',
  'method.mobile.name': 'Pesa kwa simu',
  'method.mobile.line': 'Unalipwa kwenye namba yako ya pesa kwa simu, kwa sarafu ya nchi yako.',
  'method.cash.name': 'Kuchukua pesa taslimu',
  'method.cash.line':
    'Unachukua pesa taslimu kwa wakala aliye karibu nawe, kwa sarafu ya nchi yako.',

  'destination.wallet.heading': 'USDC zifike wapi?',
  'destination.wallet.label': 'Anwani yako ya Stellar',
  'destination.wallet.hint':
    'Inakili kutoka kwenye pochi yako. Inaanza na herufi G na ina herufi 56.',
  'destination.wallet.action': 'Hifadhi anwani yangu',
  'destination.wallet.missing': 'Bandika anwani kutoka kwenye pochi yako.',
  'destination.wallet.invalid': 'Anwani hiyo si sahihi. Inakili tena kutoka kwenye pochi yako.',
  'destination.wallet.unpayable':
    'Malipo hayawezi kutumwa kwenye anwani hii. Tumia anwani ya pochi yako mwenyewe.',
  'destination.refused':
    'Anwani hii haiwezi kupokea malipo. Angalia anwani na memo, au tumia pochi nyingine.',
  'destination.memo.label': 'Memo, ikiwa tu ulipewa',
  'destination.memo.hint':
    'Iache wazi kwa pochi yako mwenyewe. Baadhi ya masoko ya kubadilishia fedha hutoa namba ya kuongeza kwenye anwani yao.',
  'destination.memo.unsupported':
    'Malipo hayawezi kubeba memo yenye herufi au alama. Tumia pochi yako mwenyewe, au anwani isiyohitaji memo au inayohitaji namba tu.',
  'destination.memo.notNeeded': 'Anwani hii haikubali memo tofauti. Iache memo wazi.',
  'destination.memo.tooLong': 'Namba hiyo ya memo ni ndefu mno. Iangalie na uiandike tena.',

  'destination.bank.heading': 'Pesa zifike kwenye akaunti ipi?',
  'destination.bank.label': 'Namba yako ya akaunti',
  'destination.bank.hint': 'Namba ya akaunti inayoonekana kwenye taarifa yako ya benki.',
  'destination.bank.action': 'Hifadhi namba yangu ya akaunti',
  'destination.bank.missing': 'Weka namba ya akaunti ambayo pesa zinapaswa kufika.',
  'destination.bank.invalid':
    'Namba hiyo ya akaunti si sahihi. Iangalie kwenye taarifa yako ya benki.',

  'destination.mobile.heading': 'Pesa zifike kwenye namba ipi?',
  'destination.mobile.label': 'Namba yako ya pesa kwa simu',
  'destination.mobile.hint': 'Namba ambayo akaunti yako ya pesa kwa simu imesajiliwa nayo.',
  'destination.mobile.action': 'Hifadhi namba yangu',
  'destination.mobile.missing': 'Weka namba ambayo pesa zinapaswa kufika.',
  'destination.mobile.invalid': 'Namba hiyo si sahihi. Iangalie na uiandike tena.',

  'destination.cash.heading': 'Tukutumie msimbo wa kuchukua pesa kwa SMS kwenye namba ipi?',
  'destination.cash.label': 'Namba yako ya simu',
  'destination.cash.hint': 'Wakala atakuomba namba hii unapochukua pesa taslimu.',
  'destination.cash.action': 'Hifadhi namba yangu',
  'destination.cash.missing': 'Weka namba ambayo msimbo wa kuchukua pesa unapaswa kutumwa.',
  'destination.cash.invalid': 'Namba hiyo si sahihi. Iangalie na uiandike tena.',

  'review.heading': 'Je, haya ni sahihi?',
  'review.hint': 'Tunalipa kwa maelezo haya hasa.',
  'review.name': 'Jina',
  'review.method': 'Jinsi unavyolipwa',
  'review.destination': 'Zinapofika',
  'review.memo': 'Memo',
  'review.change': 'Badilisha',
  'review.change.name': 'Badilisha {thing}',
  'review.action': 'Maliza usajili',

  'verify.heading': 'Thibitisha wewe ni nani',
  'verify.self.hint':
    'Self hukagua kitambulisho chako kwenye simu yako. Tunajua tu kwamba umefaulu, kamwe si chochote kutoka kwenye nyaraka zako.',
  'verify.self.action': 'Thibitisha kwa Self',
  'verify.anchor.hint':
    'Mshirika anayekulipa hukagua kitambulisho chako, kama sheria inavyomtaka. Tunajua tu kama umefaulu.',
  'verify.anchor.action': 'Endelea kwenye ukaguzi wa kitambulisho',
  'verify.waiting.heading': 'Maliza ukaguzi kwenye dirisha jipya',
  'verify.waiting.hint':
    'Ukimaliza huko, rudi hapa. Ikiwa umelifunga kwa bahati mbaya, lifungue tena.',
  'verify.waiting.status': 'Tunasubiri matokeo',
  'verify.finished': 'Nimemaliza',
  'verify.reopen': 'Fungua ukaguzi tena',
  'verify.pending': 'Matokeo bado hayajafika. Yanaweza kuchukua dakika chache.',
  'verify.rejected':
    'Kitambulisho chako hakikuweza kuthibitishwa. Hakikisha ni halali na hakijaisha muda wake, kisha ujaribu tena.',
  'verify.expired': 'Ukaguzi ulifungwa kabla haujakamilika. Uanze tena.',
  'verify.retry': 'Anza ukaguzi tena',
  'verify.failed': 'Hatukuweza kuanzisha ukaguzi. Jaribu tena baada ya muda mfupi.',

  'prove.heading': 'Thibitisha kwamba pochi hii ni yako',
  'prove.hint': 'Pochi yako inatia sahihi ujumbe mfupi. Haihamishi pesa na haigharimu chochote.',
  'prove.action': 'Tia sahihi kwa pochi yangu',
  'prove.busy': 'Tunasubiri pochi yako',
  'prove.manual.hint':
    'Kwenye pochi yako, chagua kutia sahihi ujumbe na ubandike maandishi yaliyo hapa chini. Kisha bandika sahihi ambayo pochi yako inaonyesha.',
  'prove.message.label': 'Ujumbe wa kutia sahihi',
  'prove.copy': 'Nakili',
  'prove.copy.name': 'Nakili ujumbe wa kutia sahihi',
  'prove.copied': 'Imenakiliwa',
  'prove.signature.label': 'Sahihi kutoka kwenye pochi yako',
  'prove.signature.hint': 'Ibandike kama pochi yako inavyoionyesha.',
  'prove.signature.missing': 'Bandika sahihi ambayo pochi yako ilikupa.',
  'prove.manual.action': 'Thibitisha pochi yangu',
  'prove.declined': 'Pochi yako haikutia sahihi. Jaribu tena ukiwa tayari.',
  'prove.invalid':
    'Sahihi hiyo hailingani na anwani hii. Tia sahihi ujumbe tena kwa pochi ya anwani hii.',
  'prove.expired': 'Ujumbe uliisha muda wake kabla ya kutiwa sahihi. Tia sahihi huu mpya.',

  'receive.accountNotFound':
    'Akaunti hii bado haijawashwa. Akaunti ya Stellar huwashwa kwa kiasi kidogo cha XLM, ambacho pochi nyingi huongeza unapoweka pesa kwa mara ya kwanza. Iwashe kwenye pochi yako, ongeza USDC, kisha ujaribu tena.',
  'receive.noTrustline':
    'Ongeza USDC kwenye pochi yako, kisha ujaribu tena. Kuongeza USDC kunahitaji kiasi kidogo cha XLM kwenye akaunti.',
  'receive.notAuthorized':
    'USDC bado haijawezeshwa kwa akaunti hii; uliza mtoa huduma wa pochi yako.',
  'receive.limit': 'Ongeza kikomo cha USDC kwenye pochi yako.',
  'receive.signerNotAuthorized':
    'Ufunguo huu hauwezi tena kutia sahihi kwa akaunti hii. Tia sahihi kwa ufunguo ambao kwa sasa ni mtia sahihi wa akaunti.',

  'activate.heading': 'Akaunti hii bado haiko tayari kwa USDC',
  'activate.hint':
    'Tunaweza kuiandaa ipokee USDC, bila gharama kwako. Pochi yako inatia sahihi mara moja kukubali, na hakuna kinachochukuliwa kutoka kwake.',
  'activate.action': 'Washa akaunti hii bure',
  'activate.self': 'Nitaiandaa mwenyewe',
  'activate.self.name': 'Nitaiandaa akaunti mwenyewe, kwenye pochi yangu',
  'activate.busy': 'Tunawasha akaunti yako',
  'activate.failed': 'Kuwasha hakukufanikiwa. Jaribu tena, au iandae kwenye pochi yako.',

  'done.heading': 'Uko tayari.',
  'done.body':
    'Malipo yanakufikia kama {method}. Kila malipo yanakuja na risiti unayoweza kuhifadhi.',

  'footer.byline': 'Payouts by UJIRA',
};
