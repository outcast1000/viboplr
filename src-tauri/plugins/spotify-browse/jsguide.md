# JS Hacks

## Find all section links

```js
$$('a[href^="/section"]')
```

## On Home Page Find and Navigate to the music page

```js
$('button[aria-label="Music"]').click();
```

## Om Music Page Find and Navigate on the "Made For You" Section.

```js
$$('a').find(a => a.innerText.toLowerCase().includes('made for you')).click()
```

## On Section Page Find all the playlists

```js
$$('a[href^="/playlist"]')
```

### Get the title of each playlist

```js
$$('a[href^="/playlist"]')[0].children[0].title;
```

-> Release Radar


### Get the subTitle of the playlist

```js
test = $$('a[href^="/playlist"]')[0].parentElement.children[1]
while (test.firstElementChild) {
    test = test.firstElementChild;}
test.innerText
```

->Catch all the latest music from artists you follow, plus new singles picked for you. Updates every Friday.
