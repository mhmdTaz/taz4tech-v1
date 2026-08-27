/**
 * Seed a small demo catalogue.
 *
 *   pnpm seed:demo
 *
 * Separate from `pnpm seed` on purpose. Store settings are real configuration
 * that production needs; these products are fixtures. Putting them in the same
 * script would mean one careless run against Atlas publishes three fake laptops
 * to customers.
 *
 * Deliberately covers the awkward shapes rather than three tidy products:
 * a two-axis matrix with a GAP in it, a live offer, a product with no imagery,
 * and a partially translated title.
 */

import { getContainer } from '../src/composition/index.js';
import type { Collection, Product } from '../src/modules/catalog/index.js';
import { fromCents } from '../src/platform/money/index.js';
import { closeMongo } from '../src/platform/mongo/index.js';
import { unwrapOrThrow } from '../src/platform/result/index.js';

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const main = async (): Promise<void> => {
  const container = await getContainer();
  await container.catalog.ensureIndexes();

  const storeId = container.config.storeId;
  const now = container.clock.now();
  const createdAt = new Date(now.getTime() - 86_400_000);
  const offerEndsAt = new Date(now.getTime() + 30 * 86_400_000);

  const products: Product[] = [
    {
      storeId,
      id: '01JDEMOLAPTOP000000000AAAA',
      slug: 'lenovo-ideapad-3',
      title: { en: 'Lenovo IdeaPad 3', ar: 'لينوفو ايديا باد 3' },
      description: {
        en: 'A 15.6" everyday laptop with a Ryzen 5 processor, 8 GB of memory and a fast NVMe drive.',
        ar: 'حاسوب محمول 15.6 بوصة بمعالج Ryzen 5 وذاكرة 8 غيغابايت وقرص NVMe سريع.',
      },
      brand: 'Lenovo',
      status: 'active',
      // A deliberately INCOMPLETE matrix: Silver exists only in 256GB, so the
      // product page has to show 512GB as unavailable rather than pretend.
      optionNames: ['Colour', 'Storage'],
      variants: [
        {
          sku: 'IP3-BLK-256',
          options: [
            { name: 'Colour', value: 'Black' },
            { name: 'Storage', value: '256GB' },
          ],
          price: usd(119900),
          compareAtPrice: null,
          offerEndsAt: null,
          barcode: '0195892000001',
          weightGrams: 1650,
        },
        {
          sku: 'IP3-BLK-512',
          options: [
            { name: 'Colour', value: 'Black' },
            { name: 'Storage', value: '512GB' },
          ],
          price: usd(139900),
          compareAtPrice: null,
          offerEndsAt: null,
          barcode: '0195892000002',
          weightGrams: 1650,
        },
        {
          sku: 'IP3-SLV-256',
          options: [
            { name: 'Colour', value: 'Silver' },
            { name: 'Storage', value: '256GB' },
          ],
          price: usd(124900),
          compareAtPrice: null,
          offerEndsAt: null,
          barcode: '0195892000003',
          weightGrams: 1650,
        },
      ],
      media: [
        {
          kind: 'image',
          url: '/media/laptop.svg',
          alt: {
            en: 'Lenovo IdeaPad 3, open, front view',
            ar: 'لينوفو ايديا باد 3، مفتوح، من الأمام',
          },
          width: 800,
          height: 600,
        },
      ],
      specs: [
        { name: { en: 'Processor' }, value: { en: 'AMD Ryzen 5 5500U' }, group: 'Performance' },
        { name: { en: 'Memory' }, value: { en: '8 GB DDR4' }, group: 'Performance' },
        { name: { en: 'Display' }, value: { en: '15.6" Full HD' }, group: 'Display' },
        { name: { en: 'Weight' }, value: { en: '1.65 kg' }, group: null },
      ],
      createdAt,
      updatedAt: now,
    },
    {
      storeId,
      id: '01JDEMOPHONE0000000000BBBB',
      slug: 'samsung-galaxy-a55',
      title: { en: 'Samsung Galaxy A55', fr: 'Samsung Galaxy A55' },
      description: {
        en: 'A 6.6" AMOLED phone with a 5000 mAh battery and a 50 MP main camera.',
      },
      brand: 'Samsung',
      status: 'active',
      optionNames: ['Storage'],
      variants: [
        {
          sku: 'A55-128',
          options: [{ name: 'Storage', value: '128GB' }],
          // The one live offer, so the sale badge, the struck-through price and
          // the legally required expiry all have something to render.
          price: usd(38900),
          compareAtPrice: usd(44900),
          offerEndsAt,
          barcode: '8806095000001',
          weightGrams: 213,
        },
        {
          sku: 'A55-256',
          options: [{ name: 'Storage', value: '256GB' }],
          price: usd(42900),
          compareAtPrice: null,
          offerEndsAt: null,
          barcode: '8806095000002',
          weightGrams: 213,
        },
      ],
      media: [
        {
          kind: 'image',
          url: '/media/phone.svg',
          alt: { en: 'Samsung Galaxy A55, front view' },
          width: 800,
          height: 600,
        },
      ],
      specs: [
        { name: { en: 'Display' }, value: { en: '6.6" Super AMOLED' }, group: 'Display' },
        { name: { en: 'Battery' }, value: { en: '5000 mAh' }, group: null },
      ],
      createdAt,
      updatedAt: now,
    },
    {
      storeId,
      id: '01JDEMOCABLE0000000000CCCC',
      slug: 'anker-usb-c-cable-2m',
      title: { en: 'Anker USB-C to USB-C Cable, 2 m' },
      description: { en: 'A braided 100 W charging cable, two metres long.' },
      brand: 'Anker',
      status: 'active',
      // No options and no imagery: the simple-product path and the empty-frame
      // path both need to be exercised by something.
      optionNames: [],
      variants: [
        {
          sku: 'ANK-C2C-2M',
          options: [],
          price: usd(1900),
          compareAtPrice: null,
          offerEndsAt: null,
          barcode: '0194644000001',
          weightGrams: 60,
        },
      ],
      media: [],
      specs: [],
      createdAt,
      updatedAt: now,
    },
    {
      storeId,
      id: '01JDEMODRAFT0000000000DDDD',
      slug: 'unreleased-gadget',
      title: { en: 'Unreleased Gadget' },
      description: { en: 'Should never appear on the storefront.' },
      brand: null,
      // A draft, so the e2e suite can prove unpublished products stay hidden.
      status: 'draft',
      optionNames: [],
      variants: [
        {
          sku: 'DRAFT-1',
          options: [],
          price: usd(9900),
          compareAtPrice: null,
          offerEndsAt: null,
          barcode: null,
          weightGrams: null,
        },
      ],
      media: [],
      specs: [],
      createdAt,
      updatedAt: now,
    },
  ];

  let written = 0;
  for (const product of products) {
    const result = await container.catalog.saveProduct(product);
    if (!result.ok) {
      console.error(`Rejected "${product.slug}":`, JSON.stringify(result.error, null, 2));
      process.exitCode = 1;
      return;
    }
    written++;
  }

  const collections: Collection[] = [
    {
      storeId,
      id: '01JDEMOCOLLLAPTOPS0000AAAA',
      slug: 'laptops',
      title: { en: 'Laptops', ar: 'حواسيب محمولة', fr: 'Ordinateurs portables' },
      description: { en: 'Every laptop we carry.' },
      status: 'active',
      // Rule-based: import more Lenovo laptops and this stays correct with
      // nobody editing anything.
      rules: { brands: ['Lenovo'] },
      pinnedProductIds: [],
      sort: 'newest',
      position: 0,
      createdAt,
      updatedAt: now,
    },
    {
      storeId,
      id: '01JDEMOCOLLDEALS000000BBBB',
      slug: 'deals',
      title: { en: 'Deals', ar: 'عروض' },
      description: { en: 'Everything under $500.' },
      status: 'active',
      rules: { priceMaxCents: 50000 },
      // A curated addition that the price rule alone would miss.
      pinnedProductIds: ['01JDEMOLAPTOP000000000AAAA'],
      sort: 'price-asc',
      position: 1,
      createdAt,
      updatedAt: now,
    },
    {
      storeId,
      id: '01JDEMOCOLLHIDDEN00000CCCC',
      slug: 'staff-picks',
      title: { en: 'Staff Picks' },
      description: { en: 'Should never appear on the storefront.' },
      // A draft, so the e2e suite can prove unpublished collections stay hidden.
      status: 'draft',
      rules: {},
      pinnedProductIds: ['01JDEMOCABLE0000000000CCCC'],
      sort: 'manual',
      position: 2,
      createdAt,
      updatedAt: now,
    },
  ];

  let savedCollections = 0;
  for (const collection of collections) {
    const result = await container.catalog.saveCollection(collection);
    if (!result.ok) {
      console.error(
        `Rejected collection "${collection.slug}":`,
        JSON.stringify(result.error, null, 2),
      );
      process.exitCode = 1;
      return;
    }
    savedCollections++;
  }

  console.warn(
    `Seeded ${written} demo products and ${savedCollections} collections into "${container.config.mongo.database}".`,
  );
};

main()
  .catch((error: unknown) => {
    console.error('Demo seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
