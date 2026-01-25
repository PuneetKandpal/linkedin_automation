import { ArticlePublisherRunner } from './runner';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

async function main() {
  console.log('🚀 LinkedIn Article Publisher - Starting...\n');

  const runner = new ArticlePublisherRunner('./config');

  try {
    const results = await runner.run();

    console.log('\n📊 RESULTS SUMMARY');
    console.log('='.repeat(50));

    results.forEach((result, index) => {
      console.log(`\nJob ${index + 1}:`);
      console.log(`  Status: ${result.success ? '✅ Success' : '❌ Failed'}`);
      console.log(`  Job ID: ${result.jobId}`);
      console.log(`  Account: ${result.accountId}`);
      console.log(`  Article: ${result.articleId}`);
      
      if (result.articleUrl) {
        console.log(`  URL: ${result.articleUrl}`);
      }
      
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
    });

    const outputPath = resolve('./output/results.json');
    mkdirSync(resolve('./output'), { recursive: true });
    const outputData = {
      runTimestamp: new Date().toISOString(),
      results,
      logs: runner.getLogger().getLogs(),
    };

    writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`\n💾 Results saved to: ${outputPath}`);

    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;

    console.log(`\n✨ Completed ${successCount}/${totalCount} jobs successfully\n`);

    process.exit(successCount === totalCount ? 0 : 1);

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
