import { Test, TestingModule } from '@nestjs/testing';
import { TzKTClientService } from './tzkt-client.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TzKTClientService', () => {
  let service: TzKTClientService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TzKTClientService],
    }).compile();

    service = module.get<TzKTClientService>(TzKTClientService);

    // Clear cache before each test
    service.clearCache();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('cache management', () => {
    it('should clear cache', () => {
      service.clearCache();
      expect(service.getCacheSize()).toBe(0);
    });

    it('should return cache size', () => {
      const size = service.getCacheSize();
      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThanOrEqual(0);
    });
  });
});
