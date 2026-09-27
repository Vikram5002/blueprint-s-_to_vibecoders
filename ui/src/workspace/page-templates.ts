/**
 * Ready-made sections for the Page Builder: a few clicks from an empty canvas
 * to a real-looking page, the way website builders start people off.
 *
 * Each template is plain element data - the same element types, labels and
 * colour tokens a person could place by hand - positioned relative to the
 * section's own top-left, so it can be dropped at any height on the canvas.
 */
import type { CanvasElement, CanvasElementType, DesignToken } from './page-builder-types';

type Part = Omit<CanvasElement, 'id' | 'colorToken'> & { readonly colorToken?: DesignToken };

export interface SectionTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly height: number;
  readonly parts: readonly Part[];
}

const p = (type: CanvasElementType, x: number, y: number, width: number, height: number, label: string, colorToken?: DesignToken): Part => ({
  type,
  x,
  y,
  width,
  height,
  label,
  ...(colorToken === undefined ? {} : { colorToken }),
});

export const SECTION_TEMPLATES: readonly SectionTemplate[] = [
  {
    id: 'landing',
    name: 'Landing page',
    description: 'Navbar, hero, three features, footer',
    height: 800,
    parts: [
      p('navbar', 0, 0, 1280, 64, 'Brand|Features|Pricing|About|Contact'),
      p('hero', 40, 88, 1200, 320, 'Build something people love|A short, confident line about what your product does.|Get started'),
      p('card', 40, 432, 384, 200, 'Fast|Everything loads instantly, on every device.|Learn more'),
      p('card', 448, 432, 384, 200, 'Secure|Your data stays yours, protected end to end.|Learn more', 'secondary'),
      p('card', 856, 432, 384, 200, 'Simple|No setup, no manuals - it just works.|Learn more', 'success'),
      p('testimonial', 240, 656, 800, 88, 'It replaced three tools for our team.|Ada Lovelace|Head of Product'),
      p('footer', 0, 752, 1280, 48, '© 2026 Brand|Privacy|Terms|Contact', 'dark'),
    ],
  },
  {
    id: 'pricing',
    name: 'Pricing',
    description: 'Heading and three plans',
    height: 440,
    parts: [
      p('heading', 440, 16, 400, 44, 'Simple, fair pricing'),
      p('paragraph', 390, 68, 500, 48, 'Start free. Upgrade when you are ready.', 'neutral'),
      p('pricing', 88, 120, 320, 300, 'Starter|Free|1 project|Community support', 'neutral'),
      p('pricing', 480, 120, 320, 300, 'Pro|$19/mo|Unlimited projects|Priority support|Custom domain'),
      p('pricing', 872, 120, 320, 300, 'Team|$49/mo|Everything in Pro|5 seats|Admin controls', 'secondary'),
    ],
  },
  {
    id: 'login',
    name: 'Login form',
    description: 'Email, password, remember me, sign in',
    height: 400,
    parts: [
      p('heading', 440, 20, 400, 44, 'Welcome back'),
      p('text', 440, 72, 400, 24, 'Sign in to continue', 'neutral'),
      p('email', 440, 112, 400, 44, 'you@example.com'),
      p('password', 440, 168, 400, 44, 'Password'),
      p('toggle', 440, 228, 200, 28, 'Remember me'),
      p('button', 440, 272, 400, 48, 'Sign in'),
      p('link', 440, 336, 200, 24, 'Forgot password?'),
    ],
  },
  {
    id: 'contact',
    name: 'Contact form',
    description: 'Name, email, message, send',
    height: 480,
    parts: [
      p('heading', 340, 16, 600, 44, 'Get in touch'),
      p('paragraph', 340, 68, 600, 48, "Tell us what you need and we'll reply within a day.", 'neutral'),
      p('input', 340, 128, 292, 44, 'Your name'),
      p('email', 648, 128, 292, 44, 'you@example.com'),
      p('textarea', 340, 188, 600, 160, 'Your message'),
      p('button', 340, 368, 200, 48, 'Send message'),
    ],
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    description: 'Stats row, progress, data table',
    height: 480,
    parts: [
      p('heading', 40, 16, 400, 40, 'Overview'),
      p('stat', 40, 72, 280, 100, '12.4k|Visitors this month'),
      p('stat', 344, 72, 280, 100, '3.2%|Conversion rate', 'success'),
      p('stat', 648, 72, 280, 100, '$8,120|Revenue', 'secondary'),
      p('stat', 952, 72, 280, 100, '41|Open tickets', 'warning'),
      p('progress', 40, 196, 580, 44, '72|Quarterly goal'),
      p('tabs', 40, 256, 400, 44, 'All|Active|Archived'),
      p('table', 40, 312, 1192, 150, 'Customer,Plan,Status,Since|Ada,Pro,Active,2024|Alan,Team,Active,2025|Grace,Starter,Trial,2026'),
    ],
  },
  {
    id: 'faq',
    name: 'FAQ',
    description: 'Heading and three questions',
    height: 420,
    parts: [
      p('heading', 340, 16, 600, 44, 'Frequently asked questions'),
      p('accordion', 340, 80, 600, 100, 'How does billing work?|You are billed monthly and can cancel anytime.'),
      p('accordion', 340, 196, 600, 100, 'Can I change plans later?|Yes - upgrade or downgrade whenever you like.'),
      p('accordion', 340, 312, 600, 100, 'Is my data safe?|It is encrypted in transit and at rest.'),
    ],
  },
];

/** Where to put a template: directly below the lowest element, or at the top of an empty canvas. */
export function templateTop(elements: readonly CanvasElement[]): number {
  return elements.reduce((bottom, element) => Math.max(bottom, element.y + element.height + 16), 0);
}

/** The template's elements with fresh ids, placed `top` px down; null if it would not fit on the canvas. */
export function instantiateTemplate(template: SectionTemplate, top: number, firstId: number, canvasHeight: number): CanvasElement[] | null {
  const y0 = top + template.height > canvasHeight ? canvasHeight - template.height : top;
  if (y0 < 0) return null;
  return template.parts.map((part, index) => ({ ...part, id: `el-${firstId + index}`, y: part.y + y0, colorToken: part.colorToken ?? 'primary' }));
}
