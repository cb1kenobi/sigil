import { selectTree } from '@ttylabs/sigil/components/tree';

const region = await selectTree({
  message: 'Region',
  items: [
    { text: 'Americas', items: ['us-east', 'us-west', 'sa-east'] },
    { text: 'Europe', items: ['eu-west', 'eu-central'] },
    { text: 'Asia Pacific', items: ['ap-south', 'ap-northeast'] },
  ],
});

console.log(`Deploying to ${region}`);
