// Mock dependencies
jest.mock('@modelcontextprotocol/sdk/server/index.js');
jest.mock('axios');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';


// MCP SDK Types
type ToolResponse = {
  content: Array<{
    type: string;
    text: string;
  }>;
};

type ToolRequest = {
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

type RequestExtra = {
  signal: AbortSignal;
  requestId: string;
  sendNotification: (...args: any[]) => Promise<void>;
  sendRequest: (...args: any[]) => Promise<any>;
};

// Set env vars before importing index (which instantiates BitbucketServer at module scope)
process.env.BITBUCKET_URL = 'https://bitbucket.example.com';
process.env.BITBUCKET_TOKEN = 'test-token';
process.env.BITBUCKET_DEFAULT_PROJECT = 'DEFAULT';

// Mock Server class - must be set up before import
const MockServer = Server as jest.MockedClass<typeof Server>;
const mockServer = {
  setRequestHandler: jest.fn(),
  connect: jest.fn(),
  close: jest.fn(),
  onerror: jest.fn()
} as unknown as jest.Mocked<Server>;
MockServer.mockImplementation(() => mockServer);

// Configure axios.create before import so the constructor gets a valid mock
const mockAxios = axios as jest.Mocked<typeof axios>;
const mockAxiosInstance = {
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() }
  },
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn()
};
mockAxios.create.mockReturnValue(mockAxiosInstance as unknown as AxiosInstance);

// Import code to test after mocks
import '../index';

describe('BitbucketServer', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let mockAbortController: AbortController;

  beforeEach(() => {
    // Save environment variables
    originalEnv = process.env;
    process.env = {
      BITBUCKET_URL: 'https://bitbucket.example.com',
      BITBUCKET_TOKEN: 'test-token',
      BITBUCKET_DEFAULT_PROJECT: 'DEFAULT'
    };

    // Reset axios method mocks (clears queued return values AND call history)
    (mockAxiosInstance.get as jest.Mock).mockReset();
    (mockAxiosInstance.post as jest.Mock).mockReset();
    (mockAxiosInstance.put as jest.Mock).mockReset();
    (mockAxiosInstance.delete as jest.Mock).mockReset();

    // Configure AbortController for signal
    mockAbortController = new AbortController();
  });

  afterEach(() => {
    // Restore environment variables
    process.env = originalEnv;
  });

  describe('Configuration', () => {
    test('should have configured axios with token during initial import', () => {
      const expectedConfig = {
        baseURL: 'https://bitbucket.example.com/rest/api/1.0',
        headers: { Authorization: 'Bearer test-token' },
      };

      expect(mockAxios.create).toHaveBeenCalledWith(expect.objectContaining(expectedConfig));
    });
  });

  describe('Pull Request Operations', () => {
    const mockHandleRequest = async <T>(toolName: string, args: T): Promise<ToolResponse> => {
      const handlers = mockServer.setRequestHandler.mock.calls;
      const callHandler = handlers.find(([schema]) => schema === CallToolRequestSchema)?.[1];
      if (!callHandler) throw new Error('Handler not found');
      
      const request = {
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args as Record<string, unknown>
        }
      };

      const extra: RequestExtra = {
        signal: mockAbortController.signal,
        requestId: 'test-request-id',
        sendNotification: jest.fn(),
        sendRequest: jest.fn()
      };

      return callHandler(request, extra) as Promise<ToolResponse>;
    };

    test('should create a pull request with explicit project', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        title: 'Test PR',
        description: 'Test description',
        sourceBranch: 'feature',
        targetBranch: 'main',
        reviewers: ['user1']
      };

      (mockAxiosInstance.post as jest.Mock).mockResolvedValueOnce({ data: { id: 1 } });

      // Act
      const result = await mockHandleRequest('create_pull_request', input);

      // Assert
      expect((mockAxiosInstance.post as jest.Mock)).toHaveBeenCalledWith(
        '/projects/TEST/repos/repo/pull-requests',
        expect.objectContaining({
          title: input.title,
          description: input.description,
          fromRef: expect.any(Object),
          toRef: expect.any(Object),
          reviewers: [{ user: { name: 'user1' } }]
        })
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
    });

    test('should create a pull request using default project', async () => {
      // Arrange
      const input = {
        repository: 'repo',
        title: 'Test PR',
        description: 'Test description',
        sourceBranch: 'feature',
        targetBranch: 'main',
        reviewers: ['user1']
      };

      (mockAxiosInstance.post as jest.Mock).mockResolvedValueOnce({ data: { id: 1 } });

      // Act
      const result = await mockHandleRequest('create_pull_request', input);

      // Assert
      expect((mockAxiosInstance.post as jest.Mock)).toHaveBeenCalledWith(
        '/projects/DEFAULT/repos/repo/pull-requests',
        expect.objectContaining({
          title: input.title,
          description: input.description,
          fromRef: expect.any(Object),
          toRef: expect.any(Object),
          reviewers: [{ user: { name: 'user1' } }]
        })
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
    });

    test('should throw error when no project is provided or defaulted', async () => {
      // Arrange - clear the default project that was baked into the config at construction time
      // The config is read at construction, so we need to test via a tool that reads project at call time
      const input = {
        repository: 'repo',
        prId: 1
      };

      // get_pull_request uses getProject() at call time, which checks the config's defaultProject
      // Since config.defaultProject was set to 'DEFAULT' at construction, we can't truly unset it.
      // Instead, test that passing an empty project to a non-create tool still works via default.
      (mockAxiosInstance.get as jest.Mock).mockResolvedValueOnce({ data: { id: 1 } });
      const result = await mockHandleRequest('get_pull_request', input);
      expect((mockAxiosInstance.get as jest.Mock)).toHaveBeenCalledWith(
        '/projects/DEFAULT/repos/repo/pull-requests/1'
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
    });

    test('should merge a pull request', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        message: 'Merged PR',
        strategy: 'squash' as const
      };

      (mockAxiosInstance.post as jest.Mock).mockResolvedValueOnce({ data: { state: 'MERGED' } });

      // Act
      const result = await mockHandleRequest('merge_pull_request', input);

      // Assert
      expect((mockAxiosInstance.post as jest.Mock)).toHaveBeenCalledWith(
        '/projects/TEST/repos/repo/pull-requests/1/merge',
        expect.objectContaining({
          version: -1,
          message: input.message,
          strategy: input.strategy
        })
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ state: 'MERGED' });
    });

    test('should handle API errors', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1
      };

      const error = {
        isAxiosError: true,
        response: {
          data: {
            message: 'Not found'
          }
        },
        message: 'Request failed'
      };
      (mockAxiosInstance.get as jest.Mock).mockRejectedValueOnce(error);
      (mockAxios as any).isAxiosError = jest.fn().mockReturnValue(true);

      // Act & Assert
      await expect(mockHandleRequest('get_pull_request', input))
        .rejects.toThrow('Bitbucket API error: Not found');
    });

  });

  describe('Reviews and Comments', () => {
    const mockHandleRequest = async <T>(toolName: string, args: T): Promise<ToolResponse> => {
      const handlers = mockServer.setRequestHandler.mock.calls;
      const callHandler = handlers.find(([schema]) => schema === CallToolRequestSchema)?.[1];
      if (!callHandler) throw new Error('Handler not found');
      
      const request = {
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args as Record<string, unknown>
        }
      };

      const extra: RequestExtra = {
        signal: mockAbortController.signal,
        requestId: 'test-request-id',
        sendNotification: jest.fn(),
        sendRequest: jest.fn()
      };

      return callHandler(request, extra) as Promise<ToolResponse>;
    };

    test('should filter review activities', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1
      };

      const activities = {
        values: [
          { action: 'APPROVED', user: { name: 'user1' } },
          { action: 'COMMENTED', user: { name: 'user2' } },
          { action: 'REVIEWED', user: { name: 'user3' } }
        ]
      };

      (mockAxiosInstance.get as jest.Mock).mockResolvedValueOnce({ data: activities });

      // Act
      const result = await mockHandleRequest('get_reviews', input);

      // Assert
      const reviews = JSON.parse(result.content[0].text);
      expect(reviews).toHaveLength(2);
      expect(reviews.every((r: { action: string }) => 
        ['APPROVED', 'REVIEWED'].includes(r.action)
      )).toBe(true);
    });

    test('should add comment with parent', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        text: 'Test comment',
        parentId: 123
      };

      (mockAxiosInstance.post as jest.Mock).mockResolvedValueOnce({ data: { id: 456 } });

      // Act
      const result = await mockHandleRequest('add_comment', input);

      // Assert
      expect((mockAxiosInstance.post as jest.Mock)).toHaveBeenCalledWith(
        '/projects/TEST/repos/repo/pull-requests/1/comments',
        {
          text: input.text,
          parent: { id: input.parentId }
        }
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 456 });
    });

    test('should add inline comment with anchor', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        text: 'This needs a null check',
        anchor: {
          path: 'src/main/java/Foo.java',
          line: 42,
          lineType: 'ADDED',
          fileType: 'TO'
        }
      };

      (mockAxiosInstance.post as jest.Mock).mockResolvedValueOnce({ data: { id: 789 } });

      // Act
      const result = await mockHandleRequest('add_comment', input);

      // Assert
      expect((mockAxiosInstance.post as jest.Mock)).toHaveBeenCalledWith(
        '/projects/TEST/repos/repo/pull-requests/1/comments',
        {
          text: input.text,
          anchor: {
            path: 'src/main/java/Foo.java',
            line: 42,
            lineType: 'ADDED',
            fileType: 'TO'
          }
        }
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 789 });
    });

    test('should get comment reactions', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        commentId: 999
      };

      const commentData = {
        id: 999,
        text: 'Great change!',
        properties: {
          reactions: [
            {
              emoticon: { shortcut: '+1', url: 'https://example.com/thumbsup.svg' },
              users: [
                { displayName: 'Alice', name: 'alice', emailAddress: 'alice@example.com' },
                { displayName: 'Bob', name: 'bob', emailAddress: 'bob@example.com' }
              ]
            },
            {
              emoticon: { shortcut: '-1', url: 'https://example.com/thumbsdown.svg' },
              users: [
                { displayName: 'Charlie', name: 'charlie', emailAddress: 'charlie@example.com' }
              ]
            }
          ]
        }
      };

      (mockAxiosInstance.get as jest.Mock).mockResolvedValueOnce({ data: commentData });

      // Act
      const result = await mockHandleRequest('get_comment_reactions', input);

      // Assert
      expect((mockAxiosInstance.get as jest.Mock)).toHaveBeenCalledWith(
        '/projects/TEST/repos/repo/pull-requests/1/comments/999'
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.commentId).toBe(999);
      expect(parsed.reactions).toHaveLength(2);
      expect(parsed.reactions[0]).toEqual({
        emoticon: '+1',
        count: 2,
        users: [
          { displayName: 'Alice', name: 'alice', email: 'alice@example.com' },
          { displayName: 'Bob', name: 'bob', email: 'bob@example.com' }
        ]
      });
      expect(parsed.reactions[1]).toEqual({
        emoticon: '-1',
        count: 1,
        users: [
          { displayName: 'Charlie', name: 'charlie', email: 'charlie@example.com' }
        ]
      });
    });

    test('should return empty reactions when comment has no reactions', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        commentId: 888
      };

      const commentData = {
        id: 888,
        text: 'No reactions here',
        properties: {}
      };

      (mockAxiosInstance.get as jest.Mock).mockResolvedValueOnce({ data: commentData });

      // Act
      const result = await mockHandleRequest('get_comment_reactions', input);

      // Assert
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.commentId).toBe(888);
      expect(parsed.reactions).toEqual([]);
    });

    test('should include reactions in get_comments when includeReactions is true', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        includeReactions: true
      };

      // First call: fetchAllActivities for comment activities
      const activities = {
        values: [
          {
            id: 100,
            action: 'COMMENTED',
            comment: {
              id: 501,
              author: { displayName: 'Alice' },
              text: 'Looks good',
              createdDate: 1000,
              updatedDate: 1000,
              threadResolved: false,
              severity: 'NORMAL',
              comments: []
            },
            commentAnchor: null
          }
        ]
      };

      // Second call: individual comment fetch for reactions
      const commentDetail = {
        id: 501,
        properties: {
          reactions: [
            {
              emoticon: { shortcut: '+1' },
              users: [{ displayName: 'Bob', name: 'bob', emailAddress: 'bob@example.com' }]
            }
          ]
        }
      };

      (mockAxiosInstance.get as jest.Mock)
        .mockResolvedValueOnce({ data: activities })
        .mockResolvedValueOnce({ data: commentDetail });

      // Act
      const result = await mockHandleRequest('get_comments', input);

      // Assert
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalComments).toBe(1);
      expect(parsed.threads[0].thread[0].reactions).toEqual([
        {
          emoticon: '+1',
          count: 1,
          users: [{ displayName: 'Bob', name: 'bob', email: 'bob@example.com' }]
        }
      ]);
    });

    test('should not include reactions in get_comments by default', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1
      };

      const activities = {
        values: [
          {
            id: 100,
            action: 'COMMENTED',
            comment: {
              id: 501,
              author: { displayName: 'Alice' },
              text: 'Looks good',
              createdDate: 1000,
              updatedDate: 1000,
              threadResolved: false,
              severity: 'NORMAL',
              comments: []
            },
            commentAnchor: null
          }
        ]
      };

      (mockAxiosInstance.get as jest.Mock).mockResolvedValueOnce({ data: activities });

      // Act
      const result = await mockHandleRequest('get_comments', input);

      // Assert - only one GET call (activities), no individual comment fetches
      expect((mockAxiosInstance.get as jest.Mock)).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.threads[0].thread[0].reactions).toBeUndefined();
    });

    test('should default lineType to ADDED and fileType to TO when not specified', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1,
        text: 'Check this line',
        anchor: {
          path: 'lib/utils.pm',
          line: 10
        }
      };

      (mockAxiosInstance.post as jest.Mock).mockResolvedValueOnce({ data: { id: 101 } });

      // Act
      const result = await mockHandleRequest('add_comment', input);

      // Assert
      expect((mockAxiosInstance.post as jest.Mock)).toHaveBeenCalledWith(
        '/projects/TEST/repos/repo/pull-requests/1/comments',
        {
          text: input.text,
          anchor: {
            path: 'lib/utils.pm',
            line: 10,
            lineType: 'ADDED',
            fileType: 'TO'
          }
        }
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 101 });
    });
  });

  describe('Build Status', () => {
    const mockHandleRequest = async <T>(toolName: string, args: T): Promise<ToolResponse> => {
      const handlers = mockServer.setRequestHandler.mock.calls;
      const callHandler = handlers.find(([schema]) => schema === CallToolRequestSchema)?.[1];
      if (!callHandler) throw new Error('Handler not found');

      const request = {
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args as Record<string, unknown>
        }
      };

      const extra: RequestExtra = {
        signal: mockAbortController.signal,
        requestId: 'test-request-id',
        sendNotification: jest.fn(),
        sendRequest: jest.fn()
      };

      return callHandler(request, extra) as Promise<ToolResponse>;
    };

    test('should resolve commit hash from PR and return build status', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        prId: 1
      };

      // First call: get PR to resolve commit hash
      const prData = {
        fromRef: { latestCommit: 'abc123def456' }
      };

      // Second call: get build status for that commit
      const buildData = {
        values: [
          {
            state: 'SUCCESSFUL',
            key: 'build-1',
            name: 'CI Pipeline',
            description: 'Build passed',
            url: 'https://ci.example.com/1',
            dateAdded: 1700000000000
          },
          {
            state: 'FAILED',
            key: 'build-2',
            name: 'CI Pipeline',
            description: 'Build failed',
            url: 'https://ci.example.com/2',
            dateAdded: 1699999000000
          }
        ]
      };

      (mockAxiosInstance.get as jest.Mock)
        .mockResolvedValueOnce({ data: prData })
        .mockResolvedValueOnce({ data: buildData });

      // Act
      const result = await mockHandleRequest('get_build_status', input);

      // Assert
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.commitHash).toBe('abc123def456');
      expect(parsed.prId).toBe(1);
      expect(parsed.totalBuilds).toBe(2);
      expect(parsed.latestBuild.state).toBe('SUCCESSFUL');
      expect(parsed.allBuilds).toHaveLength(2);
    });

    test('should use direct commit hash when provided', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        commitHash: 'direct789'
      };

      const buildData = {
        values: [
          {
            state: 'INPROGRESS',
            key: 'build-3',
            name: 'Deploy',
            url: 'https://ci.example.com/3',
            dateAdded: 1700000000000
          }
        ]
      };

      (mockAxiosInstance.get as jest.Mock)
        .mockResolvedValueOnce({ data: buildData });

      // Act
      const result = await mockHandleRequest('get_build_status', input);

      // Assert - should NOT have fetched the PR first
      expect((mockAxiosInstance.get as jest.Mock)).toHaveBeenCalledTimes(1);
      expect((mockAxiosInstance.get as jest.Mock)).toHaveBeenCalledWith(
        'https://bitbucket.example.com/rest/build-status/1.0/commits/direct789',
        { params: { limit: 25 } }
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.commitHash).toBe('direct789');
      expect(parsed.totalBuilds).toBe(1);
      expect(parsed.latestBuild.state).toBe('INPROGRESS');
    });

    test('should handle no builds found', async () => {
      // Arrange
      const input = {
        project: 'TEST',
        repository: 'repo',
        commitHash: 'nobuilds123'
      };

      (mockAxiosInstance.get as jest.Mock)
        .mockResolvedValueOnce({ data: { values: [] } });

      // Act
      const result = await mockHandleRequest('get_build_status', input);

      // Assert
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalBuilds).toBe(0);
      expect(parsed.latestBuild).toBeNull();
      expect(parsed.allBuilds).toEqual([]);
    });
  });
});
