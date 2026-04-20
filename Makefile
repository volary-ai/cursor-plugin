lint:
	npx --yes prettier@v3 --check .
format:
	npx --yes prettier@v3 --write .
test:
	node --test
