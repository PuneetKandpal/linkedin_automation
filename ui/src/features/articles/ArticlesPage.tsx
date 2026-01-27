import { useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../api/http';
import { ArticlesApi } from '../../api/articles';
import type { Article } from '../../api/types';
import { generateArticleId } from '../../utils/id';
import { Badge, Button, Card, Field, InlineError, InlineSuccess, Modal, Note } from '../../components/ui';

export function ArticlesPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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

  const [editLanguage, setEditLanguage] = useState('en');
  const [editTitle, setEditTitle] = useState('');
  const [editMarkdownContent, setEditMarkdownContent] = useState('');
  const [editCoverImagePath, setEditCoverImagePath] = useState('');
  const [editCommunityPostText, setEditCommunityPostText] = useState('');

  const [touched, setTouched] = useState<{ [k: string]: boolean }>({});
  const [editTouched, setEditTouched] = useState<{ [k: string]: boolean }>({});

  async function refresh() {
    setLoading(true);
    setError(null);
    setSuccess(null);
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

  const createErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!articleId.trim()) e.articleId = 'Article ID is required';
    if (!language.trim()) e.language = 'Language is required';
    if (!title.trim()) e.title = 'Title is required';
    if (!markdownContent.trim()) e.markdownContent = 'Markdown content is required';
    const cover = coverImagePath.trim();
    if (cover.length && !/^https?:\/\//i.test(cover)) e.coverImagePath = 'Cover image must be an http(s) URL';
    return e;
  }, [articleId, coverImagePath, language, markdownContent, title]);

  const canCreate = Object.keys(createErrors).length === 0;

  const editErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!editLanguage.trim()) e.language = 'Language is required';
    if (!editTitle.trim()) e.title = 'Title is required';
    if (!editMarkdownContent.trim()) e.markdownContent = 'Markdown content is required';
    const cover = editCoverImagePath.trim();
    if (cover.length && !/^https?:\/\//i.test(cover)) e.coverImagePath = 'Cover image must be an http(s) URL';
    return e;
  }, [editCoverImagePath, editLanguage, editMarkdownContent, editTitle]);

  const canSave = Object.keys(editErrors).length === 0;

  function openCreate() {
    setArticleId(generateArticleId());
    setLanguage('en');
    setTitle('');
    setMarkdownContent('');
    setCoverImagePath('');
    setCommunityPostText('');
    setTouched({});
    setError(null);
    setSuccess(null);
    setCreateOpen(true);
  }

  function openEdit(article: Article) {
    setSelectedArticleId(article.articleId);
    setEditLanguage(article.language || 'en');
    setEditTitle(article.title || '');
    setEditMarkdownContent(article.markdownContent || '');
    setEditCoverImagePath(article.coverImagePath || '');
    setEditCommunityPostText(article.communityPostText || '');
    setEditTouched({});
    setError(null);
    setSuccess(null);
    setEditOpen(true);
  }

  async function createArticle() {
    setError(null);
    setSuccess(null);
    setTouched({ articleId: true, language: true, title: true, coverImagePath: true, markdownContent: true });
    if (!canCreate) return;
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
      setCreateOpen(false);
      setSuccess('Article created');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function saveArticle() {
    if (!selected) return;
    setError(null);
    setSuccess(null);
    setEditTouched({ language: true, title: true, coverImagePath: true, markdownContent: true });
    if (!canSave) return;
    try {
      await ArticlesApi.update(selected.articleId, {
        language: editLanguage,
        title: editTitle,
        markdownContent: editMarkdownContent,
        coverImagePath: editCoverImagePath.trim().length ? editCoverImagePath.trim() : undefined,
        communityPostText: editCommunityPostText.trim().length ? editCommunityPostText.trim() : undefined,
      });
      await refresh();
      setEditOpen(false);
      setSuccess('Article updated');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function markReady(id: string) {
    setError(null);
    setSuccess(null);
    try {
      await ArticlesApi.markReady(id);
      await refresh();
      setSuccess('Article marked ready');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  return (
    <div className="grid">
      <Card
        title="Articles"
        right={
          <div className="row">
            <Button variant="primary" onClick={openCreate}>
              New article
            </Button>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
          </div>
        }
      >
        {success ? <InlineSuccess message={success} /> : null}
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
                  onClick={e => {
                    const el = e.target as HTMLElement;
                    if (el && el.closest('button, a')) return;
                    setSelectedArticleId(a.articleId);
                  }}
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
                        onClick={() => {
                          openEdit(a);
                        }}
                      >
                        Edit
                      </Button>
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

      <Modal
        open={createOpen}
        title="Create Article"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createArticle()} disabled={!canCreate}>
              Create
            </Button>
          </>
        }
      >
        {error ? <InlineError message={error} /> : null}
        <div className="form">
          <Field label="Article ID" error={touched.articleId ? createErrors.articleId : undefined}>
            <div className="inputWithButton">
              <input
                value={articleId}
                onChange={e => setArticleId(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, articleId: true }))}
              />
              <Button variant="ghost" onClick={() => setArticleId(generateArticleId())}>
                Generate
              </Button>
            </div>
          </Field>
          <Field label="Language" error={touched.language ? createErrors.language : undefined}>
            <input
              value={language}
              onChange={e => setLanguage(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, language: true }))}
            />
          </Field>
          <Field label="Title" error={touched.title ? createErrors.title : undefined}>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, title: true }))}
            />
          </Field>
          <Field label="Cover Image URL" error={touched.coverImagePath ? createErrors.coverImagePath : undefined}>
            <input
              value={coverImagePath}
              onChange={e => setCoverImagePath(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, coverImagePath: true }))}
              placeholder="https://..."
            />
          </Field>
          <Note text="LinkedIn cover upload requires an http(s) URL." />
          <Field label="Community Post Text (optional)">
            <textarea value={communityPostText} onChange={e => setCommunityPostText(e.target.value)} rows={3} />
          </Field>
          <Field label="Markdown Content" error={touched.markdownContent ? createErrors.markdownContent : undefined}>
            <textarea
              value={markdownContent}
              onChange={e => setMarkdownContent(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, markdownContent: true }))}
              rows={10}
              placeholder={'Write markdown here...\n\n- Bullet\n- Bullet\n'}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={editOpen}
        title={selected ? `Edit ${selected.title}` : 'Edit Article'}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveArticle()} disabled={!selected || !canSave}>
              Save
            </Button>
          </>
        }
      >
        {error ? <InlineError message={error} /> : null}
        {selected ? (
          <div className="form">
            <Field label="Article ID">
              <input value={selected.articleId} readOnly />
            </Field>
            <Field label="Language" error={editTouched.language ? editErrors.language : undefined}>
              <input
                value={editLanguage}
                onChange={e => setEditLanguage(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, language: true }))}
              />
            </Field>
            <Field label="Title" error={editTouched.title ? editErrors.title : undefined}>
              <input
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, title: true }))}
              />
            </Field>
            <Field label="Cover Image URL" error={editTouched.coverImagePath ? editErrors.coverImagePath : undefined}>
              <input
                value={editCoverImagePath}
                onChange={e => setEditCoverImagePath(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, coverImagePath: true }))}
                placeholder="https://..."
              />
            </Field>
            <Note text="LinkedIn cover upload requires an http(s) URL." />
            <Field label="Community Post Text (optional)">
              <textarea value={editCommunityPostText} onChange={e => setEditCommunityPostText(e.target.value)} rows={3} />
            </Field>
            <Field label="Markdown Content" error={editTouched.markdownContent ? editErrors.markdownContent : undefined}>
              <textarea
                value={editMarkdownContent}
                onChange={e => setEditMarkdownContent(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, markdownContent: true }))}
                rows={10}
              />
            </Field>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
