export const onRequestPost: PagesFunction = async () =>
  new Response(JSON.stringify({ ok: true, skeleton: true }), {
    headers: { 'content-type': 'application/json' },
  });
