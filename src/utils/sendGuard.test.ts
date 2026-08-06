/**
 * Tests for the closed-port send guard (issue #5-4-7).
 */
import { describe, it, expect } from 'vitest';
import { isSendablePort, portClosedReason } from './sendGuard';

describe('sendGuard', () => {
  describe('isSendablePort', () => {
    it('returns false when the port is missing', () => {
      expect(isSendablePort(undefined)).toBe(false);
    });

    it('returns true when the port exists and is connected', () => {
      expect(isSendablePort({ id: 'COM1', status: 'connected' })).toBe(true);
    });

    it('returns false when the port is disconnected', () => {
      expect(isSendablePort({ id: 'COM1', status: 'disconnected' })).toBe(false);
    });

    it('returns false while the port is connecting', () => {
      expect(isSendablePort({ id: 'COM1', status: 'connecting' })).toBe(false);
    });

    it('returns false when the port is in error state', () => {
      expect(isSendablePort({ id: 'COM1', status: 'error' })).toBe(false);
    });

    it('returns false when the port has no status field', () => {
      expect(isSendablePort({ id: 'COM1' })).toBe(false);
    });
  });

  describe('portClosedReason', () => {
    it('reports missing for an undefined port', () => {
      expect(portClosedReason(undefined)).toBe('missing');
    });

    it('reports null for a connected port', () => {
      expect(portClosedReason({ id: 'COM1', status: 'connected' })).toBeNull();
    });

    it('reports not-connected for every non-connected state', () => {
      expect(portClosedReason({ id: 'COM1', status: 'disconnected' })).toBe('not-connected');
      expect(portClosedReason({ id: 'COM1', status: 'connecting' })).toBe('not-connected');
      expect(portClosedReason({ id: 'COM1', status: 'error' })).toBe('not-connected');
      expect(portClosedReason({ id: 'COM1' })).toBe('not-connected');
    });
  });
});
