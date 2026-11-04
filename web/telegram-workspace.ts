const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function storeTelegramUrl(username: string | null | undefined): string | null {
  const name = username?.replace(/^@/, '') ?? '';
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name) ? `https://t.me/${name}` : null;
}

export function telegramWorkspace(username: string | null | undefined, ownerVerified: boolean) {
  const url = storeTelegramUrl(username);
  return `<section class="telegram-workspace" aria-labelledby="telegram-workspace-title"><div class="tw-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m3 10 18-7-5 18-5-7-8-4Z"/><path d="m11 14 5-6"/></svg></div><div><h2 id="telegram-workspace-title">Sua loja vive no Telegram</h2><p>Produtos, estoque, preços, aparência e avisos: configure tudo na conversa com o seu bot. A carteira, os saques e os pedidos também ficam por lá.</p>${ownerVerified ? '<p>Abra seu bot e envie <code>/admin</code> para acessar o menu da loja. Esse menu é exclusivo do responsável confirmado.</p>' : '<p>Primeiro, confirme sua conta pessoal pela etapa “Confirmar responsável”. Depois, envie <code>/admin</code> ao bot.</p>'}<div class="inline-actions">${url ? `<a class="button-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Abrir @${esc(username!.replace(/^@/, ''))}</a>` : '<a class="button-link" href="#/configuracao?step=bot">Conectar meu bot</a>'}<a class="button-link quiet" href="#/configuracao?review=1">Ver conexão e ativação</a></div></div></section>`;
}
