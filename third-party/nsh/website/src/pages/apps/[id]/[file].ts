// App Stories' screenshots and README media, served from the site's own
// build: `/apps/<id>/<file>`, copied from the reviewed catalog.
import type { APIRoute } from 'astro';
import { getShowcaseApps, readShowcaseMedia } from '../../../lib/showcases';

const TYPES: Record<string, string> = { png: 'image/png', mp4: 'video/mp4', webm: 'video/webm' };

export async function getStaticPaths() {
  return (await getShowcaseApps()).flatMap((app) => app.media.map((file) => ({ params: { id: app.id, file } })));
}

export const GET: APIRoute = async ({ params }) => {
  const bytes = await readShowcaseMedia(params.id!, params.file!);
  const type = TYPES[params.file!.split('.').pop()!.toLowerCase()];
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': type } });
};
