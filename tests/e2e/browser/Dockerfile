# pytest with Playwright and Chromium, run as an unprivileged user
FROM python:slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /tests
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install --with-deps chromium
RUN useradd --create-home tester
COPY conftest.py test_*.py ./
USER tester
CMD ["pytest", "-v", "--tb=short", "-W", "error", "-p", "no:cacheprovider"]
