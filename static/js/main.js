function stripTrailingSlash(str) {
    if(str.substr(-1) === '/') {
        return str.substr(0, str.length - 1);
    }
    return str;
}

function setNavListActive(){
    let nav_lists = document.querySelector(".main-nav").querySelectorAll("li")
    let url_map = {}
    Array.from(nav_lists).map((nav_list)=>{
        let url = stripTrailingSlash(nav_list.querySelector("a")["href"])
        url_map[url] = nav_list;
    })
    let cur_href = stripTrailingSlash(window.location["href"])
    url_map[cur_href].classList.add("active")
}

(function(){
    setNavListActive()
})()
