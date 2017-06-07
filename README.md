# SARO SMS

## Usage

```bash
git clone https://github.com/Kukua/saro-sms.git
cd saro-sms/
cp .env.example .env
chmod 600 .env
# > Edit .env

docker-compose build
docker-compose run --rm sendtexts yarn install

docker-compose up
```

## License

This software is licensed under the [MIT license](https://github.com/kukua/concava/blob/master/LICENSE).

© 2017 Kukua BV
