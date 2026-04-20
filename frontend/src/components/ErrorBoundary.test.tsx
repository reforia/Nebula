import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  // React logs the caught error to console.error; silence it to keep test
  // output readable without muting real console errors globally.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>ok</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders default fallback with the error message when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
  });

  it('renders the custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>custom fallback</div>}>
        <Boom message="kaboom" />
      </ErrorBoundary>
    );
    expect(screen.getByText('custom fallback')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('clears the error state when "Try again" is clicked', () => {
    // Render with a throwing child, then swap in a non-throwing child BEFORE
    // the click. If we clicked first, setState would clear hasError, the
    // boundary would re-render the still-throwing child, and the throw would
    // re-latch hasError — giving a false negative for recovery.
    const { rerender } = render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    rerender(
      <ErrorBoundary>
        <div>recovered</div>
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
