import { createIntelligenceKit } from '@zoveli/intelligence';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node examples/library.mjs <document-root> [more-roots...]');
  process.exit(2);
}

const { governor, tools } = createIntelligenceKit({ roots });
console.log(`Mounted ${tools.length} intelligence tools for: ${roots.join(', ')}`);

const indexed = governor.documents.indexPaths(roots);
console.log(`Indexed ${indexed.indexed.length} file(s); errors: ${indexed.errors.length}`);

const result = await governor.ask({
  query: 'What do these documents say?',
});

console.log('');
console.log(result.answer);
console.log('');
console.log(`verification=${result.verification} domain=${result.domain} receipt=${result.receipt.id}`);
for (const disclosure of result.disclosures) console.log(`- ${disclosure}`);

const audit = governor.verifyAudit();
console.log(`audit ok=${audit.ok} entries=${audit.entries}`);
