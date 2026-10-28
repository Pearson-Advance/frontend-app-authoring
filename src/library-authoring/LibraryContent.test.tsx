import fetchMock from 'fetch-mock-jest';
import { StandardModal } from '@openedx/paragon';

import { getContentSearchConfigUrl } from '@src/search-manager/data/api';
import {
  fireEvent,
  render,
  screen,
  initializeMocks,
} from '@src/testUtils';

import { mockContentLibrary } from './data/api.mocks';
import mockEmptyResult from '../search-modal/__mocks__/empty-search-result.json';
import { LibraryProvider } from './common/context/LibraryContext';
import LibraryContent from './LibraryContent';
import { libraryComponentsMock } from './__mocks__';

const searchEndpoint = 'http://mock.meilisearch.local/multi-search';

mockContentLibrary.applyMock();
const mockFetchNextPage = jest.fn();
const mockUseSearchContext = jest.fn();

const data = {
  totalContentAndCollectionHits: 0,
  contentAndCollectionHits: [],
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: mockFetchNextPage,
  searchKeywords: '',
  isFiltered: false,
  isPending: false,
};

const returnEmptyResult = (_url: string, req) => {
  const requestData = JSON.parse(req.body?.toString() ?? '');
  const query = requestData?.queries[0]?.q ?? '';
  // We have to replace the query (search keywords) in the mock results with the actual query,
  // because otherwise we may have an inconsistent state that causes more queries and unexpected results.
  mockEmptyResult.results[0].query = query;
  // And fake the required '_formatted' fields; it contains the highlighting <mark>...</mark> around matched words
  // eslint-disable-next-line no-underscore-dangle, no-param-reassign
  mockEmptyResult.results[0]?.hits.forEach((hit: any) => { hit._formatted = { ...hit }; });
  return mockEmptyResult;
};

jest.mock('../search-manager', () => ({
  ...jest.requireActual('../search-manager'),
  useSearchContext: () => mockUseSearchContext(),
}));

const withLibraryId = (libraryId: string) => ({
  extraWrapper: ({ children }: { children: React.ReactNode }) => (
    <LibraryProvider libraryId={libraryId}>
      {children}
    </LibraryProvider>
  ),
});

describe('<LibraryHome />', () => {
  const originalGetComputedStyle = window.getComputedStyle;
  const originalScrollProperties: [object, string, PropertyDescriptor | undefined][] = [
    [window, 'innerHeight', Object.getOwnPropertyDescriptor(window, 'innerHeight')],
    [window, 'scrollY', Object.getOwnPropertyDescriptor(window, 'scrollY')],
    [document.body, 'scrollHeight', Object.getOwnPropertyDescriptor(document.body, 'scrollHeight')],
  ];

  beforeEach(() => {
    const { axiosMock } = initializeMocks();

    fetchMock.post(searchEndpoint, returnEmptyResult, { overwriteRoutes: true });

    // The API method to get the Meilisearch connection details uses Axios:
    axiosMock.onGet(getContentSearchConfigUrl()).reply(200, {
      url: 'http://mock.meilisearch.local',
      index_name: 'studio',
      api_key: 'test-key',
    });
  });

  afterEach(() => {
    fetchMock.reset();
    mockFetchNextPage.mockReset();
    window.getComputedStyle = originalGetComputedStyle;
    originalScrollProperties.forEach(([target, property, descriptor]) => {
      if (descriptor) {
        Object.defineProperty(target, property, descriptor);
      } else {
        Reflect.deleteProperty(target, property);
      }
    });
  });

  it('should render a spinner while loading', async () => {
    mockUseSearchContext.mockReturnValue({
      ...data,
      isPending: true,
    });

    render(<LibraryContent />, withLibraryId(mockContentLibrary.libraryId));
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should render an empty state when there are no results', async () => {
    mockUseSearchContext.mockReturnValue({
      ...data,
      totalHits: 0,
    });
    render(<LibraryContent />, withLibraryId(mockContentLibrary.libraryId));
    expect(screen.getByText('You have not added any content to this library yet.')).toBeInTheDocument();
  });

  it('should load more results when the user scrolls to the bottom', async () => {
    mockUseSearchContext.mockReturnValue({
      ...data,
      hits: libraryComponentsMock,
      totalHits: 160,
      hasNextPage: true,
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(document.body, 'scrollHeight', { configurable: true, value: 1600 });
    render(<LibraryContent />, withLibraryId(mockContentLibrary.libraryId));

    expect(mockFetchNextPage).not.toHaveBeenCalled();
    fireEvent.scroll(window, { target: { scrollY: 1000 } });
    expect(mockFetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('loads more results from the modal scrollbar after pending content appears', () => {
    const searchResults = {
      ...data,
      hits: libraryComponentsMock,
      totalHits: 160,
      hasNextPage: true,
    };
    mockUseSearchContext.mockReturnValue({ ...searchResults, isPending: true });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(document.body, 'scrollHeight', { configurable: true, value: 6000 });

    const modal = () => (
      <StandardModal title="Select library questions" isOpen onClose={jest.fn()}>
        <LibraryContent />
      </StandardModal>
    );
    const { rerender } = render(modal(), withLibraryId(mockContentLibrary.libraryId));
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    const modalBody = screen.getByRole('dialog').querySelector('.pgn__modal-body') as HTMLElement;
    // JSDOM has no layout or loaded Paragon styles. Model the actual scrolling modal body.
    window.getComputedStyle = jest.fn((element) => ({
      ...originalGetComputedStyle(element),
      overflowY: element === modalBody ? 'auto' : 'visible',
    }));
    Object.defineProperties(modalBody, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    mockUseSearchContext.mockReturnValue(searchResults);
    rerender(modal());
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(mockFetchNextPage).not.toHaveBeenCalled();
    fireEvent.scroll(modalBody, { target: { scrollTop: 500 } });
    expect(mockFetchNextPage).not.toHaveBeenCalled();

    // Background and unrelated scroll events must not drive the modal's pagination.
    fireEvent.scroll(window, { target: { scrollY: 5200 } });
    fireEvent.scroll(screen.getByRole('dialog'));
    expect(mockFetchNextPage).not.toHaveBeenCalled();

    fireEvent.scroll(modalBody, { target: { scrollTop: 1150 } });
    expect(mockFetchNextPage).toHaveBeenCalledTimes(1);
  });
});
