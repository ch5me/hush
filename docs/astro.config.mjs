import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://hush.ch5.me',
  integrations: [
    starlight({
      title: 'Hush',
      description: 'SOPS-based secrets management for monorepos. Encrypt once, decrypt everywhere.',
      social: {
        github: 'https://github.com/ch5me/hush',
      },
      customCss: [
        './src/styles/theme.css',
        './src/styles/terminal.css',
      ],
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'theme-color',
            content: '#0a0a0c',
          },
        },
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Getting Started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Configuration', slug: 'guides/configuration' },
            { label: 'Monorepo Patterns', slug: 'guides/monorepos' },
            { label: 'AI-Native Workflow', slug: 'guides/ai-native' },
            { label: 'Threat Model', slug: 'guides/threat-model' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Commands', slug: 'reference/commands' },
            { label: 'Output Formats', slug: 'reference/formats' },
            { label: 'File Reference', slug: 'reference/files' },
          ],
        },
      ],
    }),
  ],
});
