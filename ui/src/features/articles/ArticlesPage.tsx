import { useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../api/http';
import { ArticlesApi } from '../../api/articles';
import type { Article } from '../../api/types';
import { generateArticleId } from '../../utils/id';
import { Badge, Button, Card, Field, InlineError } from '../../components/ui';

export function ArticlesPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedArticleId, setSelectedArticleId] = useState('');
  const selected = useMemo(
    () => articles.find(a => a.articleId === selectedArticleId) || null,
    [articles, selectedArticleId]
  );

  const [articleId, setArticleId] = useState(generateArticleId());
  const [language, setLanguage] = useState('en');
  const [title, setTitle] = useState('');
  const [markdownContent, setMarkdownContent] = useState('');
  const [coverImagePath, setCoverImagePath] = useState('');
  const [communityPostText, setCommunityPostText] = useState('');

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await ArticlesApi.list();
      setArticles(data);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createArticle() {
    setError(null);
    try {
      await ArticlesApi.create({
        articleId,
        language,
        title,
        markdownContent,
        coverImagePath: coverImagePath.trim().length ? coverImagePath.trim() : undefined,
        communityPostText: communityPostText.trim().length ? communityPostText.trim() : undefined,
      });
      setArticleId(generateArticleId());
      setTitle('');
      setMarkdownContent('');
      setCoverImagePath('');
      setCommunityPostText('');
      await refresh();
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function markReady(id: string) {
    setError(null);
    try {
      await ArticlesApi.markReady(id);
      await refresh();
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  return (
    <div className="grid">
      <Card
        title="Articles"
        right={
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
        }
      >
        {error ? <InlineError message={error} /> : null}
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Language</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {articles.map(a => (
                <tr
                  key={a.articleId}
                  className={a.articleId === selectedArticleId ? 'selected' : ''}
                  onClick={() => setSelectedArticleId(a.articleId)}
                >
                  <td>
                    <div className="strong">{a.title}</div>
                    <div className="muted">{a.articleId}</div>
                  </td>
                  <td>{a.language}</td>
                  <td>
                    <Badge
                      tone={
                        a.status === 'ready'
                          ? 'ok'
                          : a.status === 'published'
                          ? 'ok'
                          : a.status === 'failed'
                          ? 'danger'
                          : 'neutral'
                      }
                      text={a.status || 'draft'}
                    />
                  </td>
                  <td>
                    <div className="row">
                      <Button
                        variant="ghost"
                        disabled={a.status === 'published'}
                        onClick={() => void markReady(a.articleId)}
                      >
                        Mark Ready
                      </Button>
                      {a.publishedUrl ? (
                        <a href={a.publishedUrl} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {articles.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No articles yet
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Create Article"
        right={
          <Button variant="ghost" onClick={() => setArticleId(generateArticleId())}>
            Generate ID
          </Button>
        }
      >
        <div className="form">
          <Field label="Article ID">
            <input value={articleId} onChange={e => setArticleId(e.target.value)} />
          </Field>
          <Field label="Language">
            <input value={language} onChange={e => setLanguage(e.target.value)} />
          </Field>
          <Field label="Title">
            <input value={title} onChange={e => setTitle(e.target.value)} />
          </Field>
          <Field label="Cover Image URL (http/https)" hint="LinkedIn cover upload requires an http(s) URL">
            <input value={coverImagePath} onChange={e => setCoverImagePath(e.target.value)} />
          </Field>
          <Field label="Community Post Text (optional)">
            <textarea value={communityPostText} onChange={e => setCommunityPostText(e.target.value)} rows={3} />
          </Field>
          <Field label="Markdown Content">
            <textarea
              value={markdownContent}
              onChange={e => setMarkdownContent(e.target.value)}
              rows={10}
              placeholder={'Write markdown here...\n\n- Bullet\n- Bullet\n'}
            />
          </Field>
          <div className="row">
            <Button onClick={() => void createArticle()}>Create</Button>
          </div>
          {selected ? (
            <div className="muted">
              Selected: <span className="strong">{selected.title}</span> ({selected.articleId})
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
