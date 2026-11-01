# pytest with Playwright, Chromium and Firefox, run as an unprivileged user;
# the Python packages live in a virtual environment of their own
FROM python:slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/venv/bin
WORKDIR /tests
RUN python -m venv /opt/venv
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip
COPY requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
RUN /opt/venv/bin/playwright install --with-deps chromium firefox
RUN useradd --create-home tester
COPY conftest.py test_*.py ./
USER tester
CMD ["/opt/venv/bin/pytest", "-v", "--tb=short", "-W", "error", "-p", "no:cacheprovider"]
