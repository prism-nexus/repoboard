import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// No `globals`, so testing-library cannot register its own afterEach cleanup.
afterEach(cleanup);
