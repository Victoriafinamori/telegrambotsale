export const withdrawalLabels: Record<string, string> = {
  prepared: 'Aguardando sua confirmação',
  awaiting_confirmation: 'Aguardando sua confirmação',
  expired: 'Solicitação vencida · não enviada',
  cancelled: 'Cancelado · não enviado',
  processing: 'Em processamento na Purin',
  completed: 'Concluído',
  failed: 'Saque recusado',
  reversed: 'Falhou · saldo devolvido',
  failed_pending_reversal: 'Falhou · aguardando devolução do saldo',
};
// Never pass arbitrary provider payloads, Pix keys or credential-looking strings to chat.
export function withdrawalReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\r\n\t<>]/g, ' ').trim();
  if (
    !text ||
    text.length > 300 ||
    /https?:|bearer|token|secret|ps_live_|ps_test_|api.?key|@|\d{7}|[A-Za-z0-9_-]{32,}/i.test(text)
  )
    return null;
  return text;
}
